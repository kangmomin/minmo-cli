package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
)

var (
	errKeySize   = errors.New("auth: token key must be 32 bytes (AES-256)")
	errMalformed = errors.New("auth: sealed data too short")
)

func newGCM(key []byte) (cipher.AEAD, error) {
	if len(key) != 32 {
		return nil, errKeySize
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// Seal 은 32B key 로 AES-256-GCM 암호화한다(랜덤 nonce 를 결과에 포함). key 길이가 32가 아니면 오류.
// 결과 형식: nonce(12B) || ciphertext+tag.
func Seal(key, plaintext []byte) ([]byte, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize(), gcm.NonceSize()+len(plaintext)+gcm.Overhead())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, plaintext, nil), nil
}

// Open 은 Seal 결과를 복호화한다. 키 불일치·변조·길이 오류는 오류.
func Open(key, sealed []byte) ([]byte, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	if len(sealed) < gcm.NonceSize()+gcm.Overhead() {
		return nil, errMalformed
	}
	nonce, ct := sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():]
	return gcm.Open(nil, nonce, ct, nil)
}
