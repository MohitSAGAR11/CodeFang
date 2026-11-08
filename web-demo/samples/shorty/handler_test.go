package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestShortenThenRedirect(t *testing.T) {
	store := NewStore()
	shorten := ShortenHandler(store, "http://test")

	rec := httptest.NewRecorder()
	shorten(rec, httptest.NewRequest("POST", "/shorten", strings.NewReader(`{"url":"https://example.com"}`)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d", rec.Code)
	}
}

func TestShortenRejectsEmptyBody(t *testing.T) {
	rec := httptest.NewRecorder()
	ShortenHandler(NewStore(), "http://test")(rec, httptest.NewRequest("POST", "/shorten", strings.NewReader(`{}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
}
