package main

import (
	"context"
	"encoding/hex"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const fallbackUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

var hopByHopHeaders = map[string]bool{
	"connection":          true,
	"keep-alive":          true,
	"proxy-authenticate":  true,
	"proxy-authorization": true,
	"te":                  true,
	"trailer":             true,
	"transfer-encoding":   true,
	"upgrade":             true,
}

var forwardedHeaders = []string{
	"Content-Type",
	"Content-Length",
	"Accept-Ranges",
	"Content-Range",
	"Cache-Control",
	"ETag",
	"Last-Modified",
	"Expires",
}

type app struct {
	client *http.Client
}

func main() {
	loadSelectedEnv("../.env", "YOUTUBE_PO_TOKEN", "YOUTUBE_PO_TOKENS")
	port := env("PORT", "8091")
	server := &http.Server{
		Addr:              ":" + port,
		Handler:           newApp(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       90 * time.Second,
	}

	log.Printf("video proxy listening on :%s", port)
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func newApp() *app {
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   15 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:          512,
		MaxIdleConnsPerHost:   128,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		DisableCompression:    true,
		ForceAttemptHTTP2:     false,
	}

	return &app{
		client: &http.Client{
			Transport: transport,
			Timeout:   0,
		},
	}
}

func (a *app) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		writeCors(w)
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	switch {
	case r.URL.Path == "/healthz":
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	case strings.HasPrefix(r.URL.Path, "/api/video-stream/ydwn-proxy/"):
		a.serveYdwn(w, r)
	case strings.Contains(r.URL.Path, "/mp4-segment/"):
		a.proxyBinary(w, r, "video/mp4")
	case strings.Contains(r.URL.Path, "/segment"):
		a.proxySegment(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (a *app) proxySegment(w http.ResponseWriter, r *http.Request) {
	targetURL, err := decodeTarget(r.URL.Query().Get("t"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	upstream, err := a.fetchUpstream(r.Context(), r, targetURL)
	if err != nil {
		http.Error(w, "upstream request failed", http.StatusBadGateway)
		return
	}
	defer upstream.Body.Close()

	if upstream.StatusCode < 200 || upstream.StatusCode >= 300 {
		copyError(w, upstream)
		return
	}

	contentType := upstream.Header.Get("Content-Type")
	if shouldRewritePlaylist(contentType, targetURL) {
		body, err := io.ReadAll(io.LimitReader(upstream.Body, 32<<20))
		if err != nil {
			http.Error(w, "failed to read playlist", http.StatusBadGateway)
			return
		}

		text := string(body)
		if !strings.HasPrefix(strings.TrimSpace(text), "#EXTM3U") {
			writeBinaryHeaders(w, upstream, contentType, http.StatusOK)
			_, _ = w.Write(body)
			return
		}

		rewritten := rewritePlaylist(text, targetURL, baseProxyURL(r))
		writeCors(w)
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(upstream.StatusCode)
		_, _ = w.Write([]byte(rewritten))
		return
	}

	streamResponse(w, upstream, contentType)
}

func (a *app) proxyBinary(w http.ResponseWriter, r *http.Request, fallbackType string) {
	targetURL, err := decodeTarget(r.URL.Query().Get("t"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	upstream, err := a.fetchUpstream(r.Context(), r, targetURL)
	if err != nil {
		http.Error(w, "upstream request failed", http.StatusBadGateway)
		return
	}
	defer upstream.Body.Close()

	if upstream.StatusCode < 200 || upstream.StatusCode >= 300 {
		copyError(w, upstream)
		return
	}

	contentType := upstream.Header.Get("Content-Type")
	if contentType == "" {
		contentType = fallbackType
	}
	streamResponse(w, upstream, contentType)
}

func (a *app) fetchUpstream(ctx context.Context, r *http.Request, targetURL string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return nil, err
	}

	for key, value := range upstreamHeaders(r, targetURL) {
		req.Header.Set(key, value)
	}

	return a.client.Do(req)
}

func upstreamHeaders(r *http.Request, targetURL string) map[string]string {
	parsed, _ := url.Parse(targetURL)
	headers := map[string]string{
		"User-Agent":      firstNonEmpty(r.Header.Get("User-Agent"), fallbackUserAgent),
		"Accept":          firstNonEmpty(r.Header.Get("Accept"), "application/vnd.apple.mpegurl,application/x-mpegURL,*/*"),
		"Accept-Language": firstNonEmpty(r.Header.Get("Accept-Language"), "en-US,en;q=0.9"),
	}

	if rangeHeader := r.Header.Get("Range"); rangeHeader != "" {
		headers["Range"] = rangeHeader
	}

	referer, origin := upstreamIdentity(r, parsed)
	headers["Referer"] = referer
	if origin != "" {
		headers["Origin"] = origin
	}

	return headers
}

func upstreamIdentity(r *http.Request, target *url.URL) (string, string) {
	if override := r.URL.Query().Get("r"); override != "" {
		if parsed, err := url.Parse(override); err == nil && parsed.Scheme != "" && parsed.Host != "" {
			return override, parsed.Scheme + "://" + parsed.Host
		}
	}

	host := target.Hostname()
	switch {
	case strings.Contains(host, "dailymotion.com") || strings.Contains(host, "dmcdn.net"):
		return "https://www.dailymotion.com/", "https://www.dailymotion.com"
	case strings.Contains(host, "ok.ru") || strings.Contains(host, "mycdn.me") || strings.Contains(host, "vkuser.net"):
		return "https://ok.ru", ""
	default:
		base := target.Scheme + "://" + target.Host
		return base + "/", base
	}
}

func decodeTarget(token string) (string, error) {
	if token == "" {
		return "", errors.New("missing token")
	}

	bytes, err := hex.DecodeString(token)
	if err != nil {
		return "", errors.New("invalid token")
	}

	target := string(bytes)
	parsed, err := url.Parse(target)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("invalid target url")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", errors.New("unsupported target protocol")
	}

	return target, nil
}

func shouldRewritePlaylist(contentType string, targetURL string) bool {
	normalized := strings.ToLower(contentType)
	lowerURL := strings.ToLower(targetURL)
	return strings.Contains(normalized, "mpegurl") ||
		strings.Contains(lowerURL, ".m3u8") ||
		(strings.Contains(lowerURL, "/video/") && !strings.HasSuffix(lowerURL, ".ts"))
}

func rewritePlaylist(content string, sourceURL string, proxyBase string) string {
	lines := strings.Split(content, "\n")
	for index, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}

		if strings.HasPrefix(trimmed, "#") {
			lines[index] = rewriteUriAttributes(line, sourceURL, proxyBase)
			continue
		}

		absolute := absoluteURL(trimmed, sourceURL)
		if isHTTPURL(absolute) {
			lines[index] = proxyURL(proxyBase, absolute)
		}
	}

	return strings.Join(lines, "\n")
}

func rewriteUriAttributes(line string, sourceURL string, proxyBase string) string {
	const marker = `URI="`
	var output strings.Builder
	remaining := line

	for {
		start := strings.Index(remaining, marker)
		if start < 0 {
			output.WriteString(remaining)
			break
		}

		output.WriteString(remaining[:start+len(marker)])
		rest := remaining[start+len(marker):]
		end := strings.Index(rest, `"`)
		if end < 0 {
			output.WriteString(rest)
			break
		}

		raw := rest[:end]
		absolute := absoluteURL(raw, sourceURL)
		if isHTTPURL(absolute) {
			output.WriteString(proxyURL(proxyBase, absolute))
		} else {
			output.WriteString(raw)
		}
		remaining = rest[end:]
	}

	return output.String()
}

func absoluteURL(raw string, base string) string {
	parsed, err := url.Parse(raw)
	if err == nil && parsed.Scheme != "" {
		return parsed.String()
	}

	baseURL, err := url.Parse(base)
	if err != nil {
		return raw
	}

	relative, err := url.Parse(raw)
	if err != nil {
		return raw
	}

	return baseURL.ResolveReference(relative).String()
}

func proxyURL(proxyBase string, target string) string {
	return proxyBase + "?t=" + hex.EncodeToString([]byte(target))
}

func baseProxyURL(r *http.Request) string {
	scheme := r.Header.Get("X-Forwarded-Proto")
	if scheme == "" {
		scheme = "http"
		if r.TLS != nil {
			scheme = "https"
		}
	}

	host := r.Header.Get("X-Forwarded-Host")
	if host == "" {
		host = r.Host
	}

	return scheme + "://" + host + r.URL.Path
}

func streamResponse(w http.ResponseWriter, upstream *http.Response, contentType string) {
	writeBinaryHeaders(w, upstream, contentType, upstream.StatusCode)
	_, _ = io.Copy(w, upstream.Body)
}

func writeBinaryHeaders(w http.ResponseWriter, upstream *http.Response, contentType string, status int) {
	writeCors(w)
	if contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.Header().Set("Cache-Control", firstNonEmpty(upstream.Header.Get("Cache-Control"), "public, max-age=3600"))

	for _, key := range forwardedHeaders {
		if strings.EqualFold(key, "Content-Type") || strings.EqualFold(key, "Cache-Control") {
			continue
		}
		if value := upstream.Header.Get(key); value != "" {
			w.Header().Set(key, value)
		}
	}

	w.WriteHeader(status)
}

func copyError(w http.ResponseWriter, upstream *http.Response) {
	writeCors(w)
	for key, values := range upstream.Header {
		if hopByHopHeaders[strings.ToLower(key)] {
			continue
		}
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(upstream.StatusCode)
	_, _ = io.CopyN(w, upstream.Body, 4096)
}

func writeCors(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "*")
}

func isHTTPURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func env(key string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}
