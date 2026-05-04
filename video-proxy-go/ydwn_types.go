package main

import "time"

const (
	ydwnProxyURL     = "https://app.ytdown.to/proxy.php"
	ydwnBasePath     = "/api/video-stream/ydwn-proxy"
	ydwnCacheTTL     = 4 * time.Hour
	ydwnCaptionTTL   = time.Hour
	ydwnTargetSegSec = 6
)

type ydwnMediaItem struct {
	Type            string      `json:"type"`
	MediaPreviewURL string      `json:"mediaPreviewUrl"`
	MediaRes        interface{} `json:"mediaRes"`
	MediaQuality    string      `json:"mediaQuality"`
	MediaDuration   string      `json:"mediaDuration"`
}

type ydwnAPIResponse struct {
	API struct {
		Status          string          `json:"status"`
		Message         string          `json:"message"`
		Title           string          `json:"title"`
		ImagePreviewURL string          `json:"imagePreviewUrl"`
		MediaItems      []ydwnMediaItem `json:"mediaItems"`
	} `json:"api"`
}

type sidxEntry struct {
	Size uint32
	Dur  uint32
}

type streamMeta struct {
	Token           string
	Clen            int64
	Dur             float64
	MoovEnd         int64
	FirstMoofOffset int64
	Timescale       uint32
	SidxEntries     []sidxEntry
	Expiry          time.Time
}

type captionTrack struct {
	LanguageCode string
	Name         string
	BaseURL      string
	IsASR        bool
	IsDefault    bool
}

type timedCacheEntry struct {
	Content string
	Expiry  time.Time
}
