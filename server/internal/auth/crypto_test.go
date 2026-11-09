package auth_test

import (
	"bytes"
	"testing"

	"github.com/kangmomin/minmo-cli/server/internal/auth"
)

// F-01 / CT-18: GitHub access token 은 AES-256-GCM 으로 암호화 저장되고 E4 에서 원문으로 복원된다.
func TestSealOpen_RoundTrip_CT18(t *testing.T) {
	key := bytes.Repeat([]byte{0x42}, 32)
	plain := []byte("gho_ct_token")
	sealed, err := auth.Seal(key, plain)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if bytes.Contains(sealed, plain) {
		t.Errorf("sealed contains plaintext")
	}
	got, err := auth.Open(key, sealed)
	if err != nil || !bytes.Equal(got, plain) {
		t.Errorf("Open = (%q, %v), want %q", got, err, plain)
	}
	again, err := auth.Seal(key, plain)
	if err != nil {
		t.Fatalf("Seal 2: %v", err)
	}
	if bytes.Equal(sealed, again) {
		t.Errorf("two Seals identical — nonce must be random")
	}
}

// F-01: 키 불일치·변조·키 길이 오류는 실패
func TestSealOpen_Rejects_F01(t *testing.T) {
	key := bytes.Repeat([]byte{0x42}, 32)
	sealed, err := auth.Seal(key, []byte("secret"))
	if err != nil || len(sealed) < 5 {
		t.Fatalf("Seal: len %d err %v", len(sealed), err)
	}
	if _, err := auth.Open(bytes.Repeat([]byte{0x43}, 32), sealed); err == nil {
		t.Errorf("Open with wrong key succeeded")
	}
	tampered := append([]byte(nil), sealed...)
	tampered[len(tampered)-1] ^= 0xff
	if _, err := auth.Open(key, tampered); err == nil {
		t.Errorf("Open tampered succeeded")
	}
	if _, err := auth.Open(key, sealed[:4]); err == nil {
		t.Errorf("Open truncated succeeded")
	}
	if _, err := auth.Seal(make([]byte, 16), []byte("x")); err == nil {
		t.Errorf("Seal with 16B key succeeded, want error (AES-256 requires 32B)")
	}
}
