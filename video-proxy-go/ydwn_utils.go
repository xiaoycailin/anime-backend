package main

import (
	"bufio"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	ydwnMetaMu       sync.RWMutex
	ydwnMetaCache    = map[string]streamMeta{}
	ydwnCaptionMu    sync.RWMutex
	ydwnCaptionCache = map[string]timedCacheEntry{}
	ydwnPotMu        sync.RWMutex
	ydwnPotByVideo   = map[string]string{}
	youtubeIDPattern = regexp.MustCompile(`(?:youtube\.com/watch\?(?:.*&)?v=|youtu\.be/)([a-zA-Z0-9_-]{11})`)
)

func encodeYdwnToken(value string) string {
	return hex.EncodeToString([]byte(value))
}

func decodeYdwnToken(token string) (string, error) {
	raw, err := hex.DecodeString(token)
	if err != nil {
		return "", errors.New("invalid token")
	}
	value := string(raw)
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("invalid token")
	}
	return value, nil
}

func isYouTubeURL(value string) bool {
	return strings.Contains(value, "youtube.com/watch") || strings.Contains(value, "youtu.be/")
}

func extractYouTubeID(value string) string {
	match := youtubeIDPattern.FindStringSubmatch(value)
	if len(match) == 2 {
		return match[1]
	}
	return ""
}

func captionVideoID(value string) string {
	parsed, err := url.Parse(value)
	if err != nil {
		return ""
	}
	return parsed.Query().Get("v")
}

func setCaptionPot(videoID string, pot string) {
	if videoID == "" || strings.TrimSpace(pot) == "" {
		return
	}
	ydwnPotMu.Lock()
	ydwnPotByVideo[videoID] = strings.TrimSpace(pot)
	ydwnPotMu.Unlock()
}

func captionPot(videoID string) string {
	ydwnPotMu.RLock()
	pot := ydwnPotByVideo[videoID]
	ydwnPotMu.RUnlock()
	if strings.TrimSpace(pot) != "" {
		return pot
	}
	return strings.TrimSpace(os.Getenv("YOUTUBE_PO_TOKEN"))
}

func withCaptionClientParams(raw string, pot string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	query := parsed.Query()
	if query.Get("hl") == "" {
		query.Set("hl", firstNonEmpty(query.Get("lang"), "id"))
	}
	query.Set("fmt", "vtt")
	query.Set("xorb", "2")
	query.Set("xobt", "3")
	query.Set("xovt", "3")
	query.Set("cbr", "Chrome")
	query.Set("cbrver", "147.0.0.0")
	query.Set("c", "WEB")
	query.Set("cver", "2.20260430.08.00")
	query.Set("cplayer", "UNIPLAYER")
	query.Set("cos", "Windows")
	query.Set("cosver", "10.0")
	query.Set("cplatform", "DESKTOP")
	if strings.TrimSpace(pot) != "" {
		query.Set("potc", "1")
		query.Set("pot", strings.TrimSpace(pot))
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func extractMediaInfo(previewURL string) (int64, float64, bool) {
	parsed, err := url.Parse(previewURL)
	if err != nil {
		return 0, 0, false
	}
	clen, err := strconv.ParseInt(parsed.Query().Get("clen"), 10, 64)
	if err != nil || clen <= 0 {
		return 0, 0, false
	}
	dur, err := strconv.ParseFloat(parsed.Query().Get("dur"), 64)
	if err != nil || dur <= 0 {
		return 0, 0, false
	}
	return clen, dur, true
}

func ydwnBaseURL(r *http.Request) string {
	scheme := r.Header.Get("X-Forwarded-Proto")
	if scheme == "" {
		scheme = "http"
		if r.TLS != nil {
			scheme = "https"
		}
	}
	host := firstNonEmpty(r.Header.Get("X-Forwarded-Host"), r.Host)
	return fmt.Sprintf("%s://%s%s", scheme, host, ydwnBasePath)
}

func getCachedMeta(token string) (streamMeta, bool) {
	ydwnMetaMu.RLock()
	meta, ok := ydwnMetaCache[token]
	ydwnMetaMu.RUnlock()
	return meta, ok && time.Now().Before(meta.Expiry)
}

func putCachedMeta(meta streamMeta) {
	ydwnMetaMu.Lock()
	ydwnMetaCache[meta.Token] = meta
	ydwnMetaMu.Unlock()
}

func loadSelectedEnv(path string, keys ...string) {
	allowed := map[string]bool{}
	for _, key := range keys {
		allowed[key] = true
	}
	file, err := os.Open(filepath.Clean(path))
	if err != nil {
		return
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !ok || !allowed[key] || os.Getenv(key) != "" {
			continue
		}
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		_ = os.Setenv(key, value)
	}
}
