package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

var ydwnQualityRank = map[string]int{"SD": 0, "HD": 1, "FHD": 2}

func (a *app) serveYdwn(w http.ResponseWriter, r *http.Request) {
	switch strings.TrimPrefix(r.URL.Path, ydwnBasePath) {
	case "/playlist":
		a.ydwnPlaylist(w, r)
	case "/captions":
		a.ydwnCaptions(w, r)
	case "/media-playlist":
		a.ydwnMediaPlaylist(w, r)
	case "/subtitle-playlist":
		a.ydwnSubtitlePlaylist(w, r)
	case "/subtitle-vtt":
		a.ydwnSubtitleVTT(w, r)
	case "/segment":
		a.ydwnSegment(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (a *app) ydwnCaptions(w http.ResponseWriter, r *http.Request) {
	rawURL := r.URL.Query().Get("url")
	if rawURL == "" || !isYouTubeURL(rawURL) {
		http.Error(w, "invalid or missing YouTube URL", http.StatusBadRequest)
		return
	}
	videoID := extractYouTubeID(rawURL)
	if videoID == "" {
		http.Error(w, "cannot extract YouTube video id", http.StatusBadRequest)
		return
	}
	setCaptionPot(videoID, r.URL.Query().Get("pot"))
	pots := captionPots(videoID)
	base := ydwnBaseURL(r)
	tracks := a.fetchYouTubeCaptions(r.Context(), videoID)
	data := []map[string]string{}
	fallbackData := []map[string]string{}
	for _, track := range tracks {
		label := track.Name
		if track.IsASR {
			label += " (auto)"
		}
		fallbackURL := firstCaptionURLCandidate(track.BaseURL, pots)
		if fallbackURL != "" {
			fallbackData = append(fallbackData, map[string]string{
				"label": label,
				"lang":  track.LanguageCode,
				"src":   base + "/subtitle-vtt?t=" + encodeYdwnToken(fallbackURL),
			})
		}

		captionURL, ok := a.resolveCaptionURL(r.Context(), track.BaseURL, pots)
		if !ok {
			continue
		}
		data = append(data, map[string]string{
			"label": label,
			"lang":  track.LanguageCode,
			"src":   base + "/subtitle-vtt?t=" + encodeYdwnToken(captionURL),
		})
	}
	if len(data) == 0 {
		data = fallbackData
	}
	writeJSON(w, map[string]interface{}{"data": data}, "public, max-age=300")
}

func (a *app) ydwnPlaylist(w http.ResponseWriter, r *http.Request) {
	rawURL := r.URL.Query().Get("url")
	if rawURL == "" || !isYouTubeURL(rawURL) {
		http.Error(w, "invalid or missing YouTube URL", http.StatusBadRequest)
		return
	}
	setCaptionPot(extractYouTubeID(rawURL), r.URL.Query().Get("pot"))
	items, err := a.fetchYdwnItems(r.Context(), rawURL)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	videos := filterYdwnItems(items, "Video")
	audios := filterYdwnItems(items, "Audio")
	sort.SliceStable(videos, func(i, j int) bool {
		return ydwnQualityRank[videos[i].MediaQuality] < ydwnQualityRank[videos[j].MediaQuality]
	})
	if len(videos) == 0 {
		http.Error(w, "no video streams found", http.StatusBadGateway)
		return
	}

	var audio *ydwnMediaItem
	for i := range audios {
		if audio == nil || audios[i].MediaQuality == "128K" {
			audio = &audios[i]
		}
	}

	videoMetas := make([]*streamMeta, len(videos))
	for i := range videos {
		if meta, err := a.buildYdwnMeta(r.Context(), videos[i].MediaPreviewURL); err == nil {
			videoMetas[i] = &meta
		}
	}
	var audioMeta *streamMeta
	if audio != nil {
		if meta, err := a.buildYdwnMeta(r.Context(), audio.MediaPreviewURL); err == nil {
			audioMeta = &meta
		}
	}

	base := ydwnBaseURL(r)
	lines := []string{"#EXTM3U", "#EXT-X-VERSION:6", ""}
	if audioMeta != nil {
		lines = append(lines,
			`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="yt-audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="`+base+`/media-playlist?t=`+audioMeta.Token+`"`,
			"",
		)
	}
	for i, meta := range videoMetas {
		if meta == nil {
			continue
		}
		bw := int64(float64(meta.Clen*8) / meta.Dur)
		resolution := mediaResolution(videos[i].MediaRes)
		resAttr := ""
		if resolution != "" {
			resAttr = ",RESOLUTION=" + resolution
		}
		audioAttr := ""
		if audioMeta != nil {
			audioAttr = `,AUDIO="yt-audio"`
		}
		lines = append(lines,
			"#EXT-X-STREAM-INF:BANDWIDTH="+strconv.FormatInt(bw, 10)+resAttr+audioAttr,
			base+"/media-playlist?t="+meta.Token,
		)
	}
	writeText(w, "application/vnd.apple.mpegurl", "public, max-age=300", strings.Join(lines, "\n"))
}

func (a *app) ydwnMediaPlaylist(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("t")
	if token == "" {
		http.Error(w, "missing token", http.StatusBadRequest)
		return
	}
	meta, ok := getCachedMeta(token)
	if !ok {
		target, err := decodeYdwnToken(token)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		meta, err = a.buildYdwnMeta(r.Context(), target)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
	}
	writeText(w, "application/vnd.apple.mpegurl", "public, max-age=3600", buildYdwnMediaPlaylist(r, meta))
}

func (a *app) ydwnSubtitlePlaylist(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("t")
	if _, err := decodeYdwnToken(token); token == "" || err != nil {
		http.Error(w, "invalid token", http.StatusBadRequest)
		return
	}
	dur, _ := strconv.ParseFloat(r.URL.Query().Get("dur"), 64)
	if dur <= 0 {
		dur = 99999
	}
	base := ydwnBaseURL(r)
	lines := []string{"#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-PLAYLIST-TYPE:VOD",
		"#EXT-X-TARGETDURATION:" + strconv.Itoa(int(math.Ceil(dur))),
		"#EXTINF:" + strconv.FormatFloat(dur, 'f', 3, 64) + ",",
		base + "/subtitle-vtt?t=" + token,
		"#EXT-X-ENDLIST",
	}
	writeText(w, "application/vnd.apple.mpegurl", "public, max-age=3600", strings.Join(lines, "\n"))
}

func (a *app) ydwnSubtitleVTT(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("t")
	target, err := decodeYdwnToken(token)
	if token == "" || err != nil {
		http.Error(w, "invalid token", http.StatusBadRequest)
		return
	}
	videoID := captionVideoID(target)
	content := a.fetchCaptionContent(r.Context(), target, captionPots(videoID))
	if content == "" {
		writeText(w, "text/vtt; charset=utf-8", "public, max-age=300", "WEBVTT\n\n")
		return
	}
	writeText(w, "text/vtt; charset=utf-8", "public, max-age=3600", content)
}

func (a *app) ydwnSegment(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("t")
	target, err := decodeYdwnToken(token)
	if token == "" || err != nil {
		http.Error(w, "invalid token", http.StatusBadRequest)
		return
	}
	upstream, err := a.fetchUpstream(r.Context(), r, target)
	if err != nil {
		http.Error(w, "upstream request failed", http.StatusBadGateway)
		return
	}
	defer upstream.Body.Close()
	if upstream.StatusCode < 200 || upstream.StatusCode >= 300 {
		copyError(w, upstream)
		return
	}
	streamResponse(w, upstream, firstNonEmpty(upstream.Header.Get("Content-Type"), "video/mp4"))
}

func (a *app) resolveCaptionURL(ctx context.Context, rawURL string, pots []string) (string, bool) {
	for _, candidate := range captionURLCandidates(rawURL, pots) {
		if a.fetchCaptionVTT(ctx, candidate) != "" {
			return candidate, true
		}
	}
	return "", false
}

func (a *app) fetchCaptionContent(ctx context.Context, rawURL string, pots []string) string {
	for _, candidate := range captionURLCandidates(rawURL, pots) {
		if content := a.fetchCaptionVTT(ctx, candidate); content != "" {
			return content
		}
	}
	return ""
}

func captionURLCandidates(rawURL string, pots []string) []string {
	values := []string{
		withCaptionClientParams(rawURL, ""),
	}
	for _, pot := range pots {
		if strings.TrimSpace(pot) != "" {
			values = append(values, withCaptionClientParams(rawURL, pot))
		}
	}

	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func firstCaptionURLCandidate(rawURL string, pots []string) string {
	candidates := captionURLCandidates(rawURL, pots)
	if len(candidates) == 0 {
		return ""
	}
	return candidates[0]
}

func (a *app) fetchYdwnItems(ctx context.Context, youtubeURL string) ([]ydwnMediaItem, error) {
	body := url.Values{"url": {youtubeURL}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ydwnProxyURL, strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", fallbackUserAgent)
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Referer", "https://ytdown.to/")
	req.Header.Set("Origin", "https://ytdown.to")

	res, err := a.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, errors.New("ytdown.to returned " + strconv.Itoa(res.StatusCode))
	}
	var payload ydwnAPIResponse
	if json.NewDecoder(res.Body).Decode(&payload) != nil {
		return nil, errors.New("invalid ytdown.to response")
	}
	if payload.API.Status != "ok" {
		return nil, errors.New(firstNonEmpty(payload.API.Message, "ytdown.to non-ok"))
	}
	return payload.API.MediaItems, nil
}

func (a *app) buildYdwnMeta(ctx context.Context, previewURL string) (streamMeta, error) {
	clen, dur, ok := extractMediaInfo(previewURL)
	if !ok {
		return streamMeta{}, errors.New("cannot extract media info from URL")
	}
	token := encodeYdwnToken(previewURL)
	if meta, ok := getCachedMeta(token); ok {
		return meta, nil
	}
	parsed, err := a.parseFmp4Header(ctx, previewURL)
	if err != nil {
		return streamMeta{}, err
	}
	parsed.Token = token
	parsed.Clen = clen
	parsed.Dur = dur
	parsed.Expiry = time.Now().Add(ydwnCacheTTL)
	putCachedMeta(parsed)
	return parsed, nil
}

func (a *app) parseFmp4Header(ctx context.Context, previewURL string) (streamMeta, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, previewURL, nil)
	if err != nil {
		return streamMeta{}, err
	}
	req.Header.Set("User-Agent", fallbackUserAgent)
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Range", "bytes=0-524287")
	res, err := a.client.Do(req)
	if err != nil {
		return streamMeta{}, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return streamMeta{}, errors.New("failed to fetch fMP4 header")
	}
	buf, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return streamMeta{}, err
	}
	return parseFmp4HeaderBytes(buf)
}

func parseFmp4HeaderBytes(buf []byte) (streamMeta, error) {
	var meta streamMeta
	reader := bytes.NewReader(buf)
	for reader.Len() >= 8 {
		boxStart := int64(len(buf) - reader.Len())
		var size uint32
		if binary.Read(reader, binary.BigEndian, &size) != nil {
			break
		}
		typ := make([]byte, 4)
		if _, err := io.ReadFull(reader, typ); err != nil {
			break
		}
		if size < 8 || size > 1_000_000_000 || int(size)-8 > reader.Len() {
			break
		}
		payload := make([]byte, int(size)-8)
		_, _ = io.ReadFull(reader, payload)
		boxEnd := boxStart + int64(size)
		switch string(typ) {
		case "moov":
			meta.MoovEnd = boxEnd
		case "sidx":
			parseSidx(payload, boxStart, int64(size), &meta)
		}
		if meta.MoovEnd > 0 && meta.FirstMoofOffset > 0 {
			break
		}
	}
	if meta.MoovEnd == 0 {
		return streamMeta{}, errors.New("failed to parse fMP4 header")
	}
	if meta.FirstMoofOffset == 0 {
		meta.FirstMoofOffset = meta.MoovEnd
	}
	return meta, nil
}

func parseSidx(payload []byte, boxStart int64, boxSize int64, meta *streamMeta) {
	if len(payload) < 16 {
		return
	}
	version := payload[0]
	meta.Timescale = binary.BigEndian.Uint32(payload[8:12])
	pos := 12
	var firstOffset uint64
	if version == 0 {
		if len(payload) < pos+8 {
			return
		}
		firstOffset = uint64(binary.BigEndian.Uint32(payload[pos+4 : pos+8]))
		pos += 8
	} else {
		if len(payload) < pos+16 {
			return
		}
		firstOffset = uint64(binary.BigEndian.Uint32(payload[pos+8:pos+12]))<<32 | uint64(binary.BigEndian.Uint32(payload[pos+12:pos+16]))
		pos += 16
	}
	if len(payload) < pos+4 {
		return
	}
	pos += 2
	count := int(binary.BigEndian.Uint16(payload[pos : pos+2]))
	pos += 2
	entries := make([]sidxEntry, 0, count)
	for i := 0; i < count && len(payload) >= pos+12; i++ {
		refInfo := binary.BigEndian.Uint32(payload[pos : pos+4])
		if refInfo>>31 != 0 {
			return
		}
		entries = append(entries, sidxEntry{Size: refInfo & 0x7fffffff, Dur: binary.BigEndian.Uint32(payload[pos+4 : pos+8])})
		pos += 12
	}
	meta.FirstMoofOffset = boxStart + boxSize + int64(firstOffset)
	meta.SidxEntries = entries
}
