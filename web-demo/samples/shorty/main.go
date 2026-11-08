package main

import (
	"log"
	"net/http"
	"os"
)

func main() {
	addr := ":8080"
	if p := os.Getenv("PORT"); p != "" {
		addr = ":" + p
	}

	store := NewStore()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /shorten", ShortenHandler(store, "http://localhost"+addr))
	mux.HandleFunc("GET /{code}", RedirectHandler(store))

	log.Printf("shorty listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
