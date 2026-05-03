package main

import (
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"strings"
)

func buildYdwnMediaPlaylist(r *http.Request, meta streamMeta) string {
	segURL := ydwnBaseURL(r) + "/segment?t=" + meta.Token
	lines := []string{"#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-PLAYLIST-TYPE:VOD"}
	if len(meta.SidxEntries) > 0 && meta.Timescale > 0 {
		groups := groupSidxEntries(meta)
		lines = append(lines,
			"#EXT-X-TARGETDURATION:"+strconv.Itoa(int(math.Ceil(ydwnTargetSegSec*1.5))),
			`#EXT-X-MAP:URI="`+segURL+`",BYTERANGE="`+strconv.FormatInt(meta.MoovEnd, 10)+`@0"`,
			"",
		)
		for _, group := range groups {
			lines = append(lines,
				"#EXT-X-BYTERANGE:"+strconv.FormatInt(group.byteLen, 10)+"@"+strconv.FormatInt(group.byteOffset, 10),
				"#EXTINF:"+strconv.FormatFloat(group.dur, 'f', 3, 64)+",",
				segURL,
			)
		}
	} else {
		lines = append(lines,
			"#EXT-X-TARGETDURATION:"+strconv.Itoa(int(math.Ceil(meta.Dur))),
			`#EXT-X-MAP:URI="`+segURL+`",BYTERANGE="`+strconv.FormatInt(meta.MoovEnd, 10)+`@0"`,
			"",
			"#EXT-X-BYTERANGE:"+strconv.FormatInt(meta.Clen-meta.FirstMoofOffset, 10)+"@"+strconv.FormatInt(meta.FirstMoofOffset, 10),
			"#EXTINF:"+strconv.FormatFloat(meta.Dur, 'f', 3, 64)+",",
			segURL,
		)
	}
	lines = append(lines, "#EXT-X-ENDLIST")
	return strings.Join(lines, "\n")
}

type sidxGroup struct {
	byteOffset int64
	byteLen    int64
	dur        float64
}

func groupSidxEntries(meta streamMeta) []sidxGroup {
	targetTicks := uint64(ydwnTargetSegSec * float64(meta.Timescale))
	groups := []sidxGroup{}
	offset := meta.FirstMoofOffset
	var bytes int64
	var ticks uint64
	flush := func() {
		if bytes == 0 {
			return
		}
		groups = append(groups, sidxGroup{
			byteOffset: offset,
			byteLen:    bytes,
			dur:        float64(ticks) / float64(meta.Timescale),
		})
		offset += bytes
		bytes = 0
		ticks = 0
	}
	for _, entry := range meta.SidxEntries {
		bytes += int64(entry.Size)
		ticks += uint64(entry.Dur)
		if ticks >= targetTicks {
			flush()
		}
	}
	flush()
	return groups
}

func filterYdwnItems(items []ydwnMediaItem, kind string) []ydwnMediaItem {
	out := []ydwnMediaItem{}
	for _, item := range items {
		if item.Type == kind && item.MediaPreviewURL != "" {
			out = append(out, item)
		}
	}
	return out
}

func mediaResolution(value interface{}) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func writeText(w http.ResponseWriter, contentType string, cacheControl string, body string) {
	writeCors(w)
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", cacheControl)
	_, _ = w.Write([]byte(body))
}

func writeJSON(w http.ResponseWriter, payload interface{}, cacheControl string) {
	writeCors(w)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", cacheControl)
	_ = json.NewEncoder(w).Encode(payload)
}
