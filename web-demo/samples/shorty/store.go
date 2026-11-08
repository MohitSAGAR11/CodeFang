package main

import (
	"crypto/rand"
	"math/big"
	"sync"
)

const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"

// Store maps short codes to target URLs.
type Store struct {
	mu    sync.Mutex
	links map[string]string
}

func NewStore() *Store {
	return &Store{links: make(map[string]string)}
}

// Put stores url under a fresh code and returns the code.
func (s *Store) Put(url string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	for {
		code := randomCode(6)
		if _, taken := s.links[code]; !taken {
			s.links[code] = url
			return code
		}
	}
}

// Get returns the target URL for code.
func (s *Store) Get(code string) (string, bool) {
	url, ok := s.links[code]
	return url, ok
}

func randomCode(n int) string {
	b := make([]byte, n)
	max := big.NewInt(int64(len(alphabet)))
	for i := range b {
		idx, _ := rand.Int(rand.Reader, max)
		b[i] = alphabet[idx.Int64()]
	}
	return string(b)
}
