package main

import (
	"context"
	"encoding/json"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

func (a *app) fetchYouTubeCaptions(ctx context.Context, videoID string) []captionTrack {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://www.youtube.com/watch?v="+url.QueryEscape(videoID), nil)
	if err != nil {
		return nil
	}
	req.Header.Set("User-Agent", fallbackUserAgent)
	req.Header.Set("Accept", "text/html")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")

	res, err := a.client.Do(req)
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil
	}

	body, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return nil
	}
	player := extractPlayerResponse(string(body))
	if player == nil {
		return nil
	}

	captions, _ := player["captions"].(map[string]interface{})
	renderer, _ := captions["playerCaptionsTracklistRenderer"].(map[string]interface{})
	rawTracks, _ := renderer["captionTracks"].([]interface{})
	tracks := make([]captionTrack, 0, len(rawTracks))
	for _, item := range rawTracks {
		track, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		baseURL, _ := track["baseUrl"].(string)
		if baseURL == "" {
			continue
		}
		lang, _ := track["languageCode"].(string)
		name := lang
		if nameObj, ok := track["name"].(map[string]interface{}); ok {
			if simple, ok := nameObj["simpleText"].(string); ok && simple != "" {
				name = simple
			}
		}
		kind, _ := track["kind"].(string)
		tracks = append(tracks, captionTrack{
			LanguageCode: firstNonEmpty(lang, "und"),
			Name:         firstNonEmpty(name, "Unknown"),
			BaseURL:      baseURL,
			IsASR:        kind == "asr",
		})
	}
	return tracks
}

func extractPlayerResponse(page string) map[string]interface{} {
	marker := "ytInitialPlayerResponse ="
	start := strings.Index(page, marker)
	if start < 0 {
		return nil
	}
	depth, objStart, objEnd := 0, -1, -1
	inString, escape := false, false
	for i := start + len(marker); i < len(page); i++ {
		c := page[i]
		if escape {
			escape = false
			continue
		}
		if c == '\\' && inString {
			escape = true
			continue
		}
		if c == '"' {
			inString = !inString
			continue
		}
		if inString {
			continue
		}
		if c == '{' {
			if depth == 0 {
				objStart = i
			}
			depth++
		} else if c == '}' {
			depth--
			if depth == 0 {
				objEnd = i
				break
			}
		}
	}
	if objStart < 0 || objEnd < 0 {
		return nil
	}
	var out map[string]interface{}
	if json.Unmarshal([]byte(page[objStart:objEnd+1]), &out) != nil {
		return nil
	}
	return out
}

func (a *app) fetchCaptionVTT(ctx context.Context, targetURL string) string {
	ydwnCaptionMu.RLock()
	cached, ok := ydwnCaptionCache[targetURL]
	ydwnCaptionMu.RUnlock()
	if ok && time.Now().Before(cached.Expiry) {
		return cached.Content
	}

	for _, format := range []string{"vtt", "json3", "srv3", ""} {
		candidate := setCaptionFormat(targetURL, format)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, candidate, nil)
		if err != nil {
			continue
		}
		req.Header.Set("User-Agent", fallbackUserAgent)
		req.Header.Set("Accept-Language", "en-US,en;q=0.9,id;q=0.8")
		req.Header.Set("Accept", "text/vtt,application/json,text/xml,text/plain,*/*")
		req.Header.Set("Referer", "https://www.youtube.com/")
		req.Header.Set("Origin", "https://www.youtube.com")

		res, err := a.client.Do(req)
		if err != nil {
			continue
		}
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 16<<20))
		res.Body.Close()
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			continue
		}
		normalized := normalizeTimedText(string(raw))
		if normalized == "" {
			continue
		}
		if !strings.HasSuffix(normalized, "\n") {
			normalized += "\n"
		}
		ydwnCaptionMu.Lock()
		ydwnCaptionCache[targetURL] = timedCacheEntry{Content: normalized, Expiry: time.Now().Add(ydwnCaptionTTL)}
		ydwnCaptionMu.Unlock()
		return normalized
	}
	return ""
}

func setCaptionFormat(raw string, format string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	query := parsed.Query()
	if format == "" {
		query.Del("fmt")
	} else {
		query.Set("fmt", format)
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func normalizeTimedText(raw string) string {
	text := strings.TrimSpace(raw)
	if text == "" {
		return ""
	}
	if strings.HasPrefix(text, "WEBVTT") && strings.Contains(text, "-->") {
		return text
	}
	if strings.HasPrefix(text, "{") {
		return youtubeJSONToVTT(text)
	}
	if strings.Contains(text, "<text") {
		return youtubeXMLToVTT(text)
	}
	return ""
}

func youtubeXMLToVTT(raw string) string {
	re := regexp.MustCompile(`<text\b([^>]*)>([\s\S]*?)</text>`)
	cues := []string{}
	for _, match := range re.FindAllStringSubmatch(raw, -1) {
		start, okStart := xmlAttrFloat(match[1], "start")
		dur, okDur := xmlAttrFloat(match[1], "dur")
		body := normalizeCaptionText(match[2])
		if !okStart || !okDur || dur <= 0 || body == "" {
			continue
		}
		cues = append(cues, formatVTTTime(start)+" --> "+formatVTTTime(start+dur)+"\n"+body)
	}
	if len(cues) == 0 {
		return ""
	}
	return "WEBVTT\n\n" + strings.Join(cues, "\n\n") + "\n"
}

func youtubeJSONToVTT(raw string) string {
	var payload struct {
		Events []struct {
			StartMs int64 `json:"tStartMs"`
			DurMs   int64 `json:"dDurationMs"`
			Segs    []struct {
				Text string `json:"utf8"`
			} `json:"segs"`
		} `json:"events"`
	}
	if json.Unmarshal([]byte(raw), &payload) != nil {
		return ""
	}
	cues := []string{}
	for _, event := range payload.Events {
		var builder strings.Builder
		for _, seg := range event.Segs {
			builder.WriteString(seg.Text)
		}
		body := normalizeCaptionText(builder.String())
		if event.DurMs <= 0 || body == "" {
			continue
		}
		start := float64(event.StartMs) / 1000
		end := float64(event.StartMs+event.DurMs) / 1000
		cues = append(cues, formatVTTTime(start)+" --> "+formatVTTTime(end)+"\n"+body)
	}
	if len(cues) == 0 {
		return ""
	}
	return "WEBVTT\n\n" + strings.Join(cues, "\n\n") + "\n"
}

func normalizeCaptionText(value string) string {
	clean := regexp.MustCompile(`<[^>]+>`).ReplaceAllString(value, "")
	return strings.TrimSpace(html.UnescapeString(clean))
}

func xmlAttrFloat(attrs string, name string) (float64, bool) {
	re := regexp.MustCompile(name + `="([^"]+)"`)
	match := re.FindStringSubmatch(attrs)
	if len(match) != 2 {
		return 0, false
	}
	value, err := strconv.ParseFloat(match[1], 64)
	return value, err == nil
}

func formatVTTTime(seconds float64) string {
	ms := int64(seconds*1000 + 0.5)
	if ms < 0 {
		ms = 0
	}
	h := ms / 3600000
	m := (ms % 3600000) / 60000
	s := (ms % 60000) / 1000
	r := ms % 1000
	return strconv.FormatInt(h/10, 10) + strconv.FormatInt(h%10, 10) + ":" +
		strconv.FormatInt(m/10, 10) + strconv.FormatInt(m%10, 10) + ":" +
		strconv.FormatInt(s/10, 10) + strconv.FormatInt(s%10, 10) + "." +
		strconv.FormatInt(r/100, 10) + strconv.FormatInt((r/10)%10, 10) + strconv.FormatInt(r%10, 10)
}
