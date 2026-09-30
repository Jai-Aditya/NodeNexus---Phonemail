package config

import "testing"

func TestTokenMustBeStrong(t *testing.T) {
	for _, tok := range []string{"", "change-me-dev-token", "short-token"} {
		t.Setenv("INTERNAL_TOKEN", tok)
		if _, err := Load(); err == nil {
			t.Fatalf("token %q should be refused", tok)
		}
	}
	t.Setenv("INTERNAL_TOKEN", "0123456789abcdef0123456789abcdef")
	if _, err := Load(); err != nil {
		t.Fatal(err)
	}
}
