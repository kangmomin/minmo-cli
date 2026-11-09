package auth

// Seal 은 32B key 로 AES-256-GCM 암호화한다(랜덤 nonce 를 결과에 포함). key 길이가 32가 아니면 오류.
func Seal(key, plaintext []byte) ([]byte, error) {
	return nil, errNotImplemented
}

// Open 은 Seal 결과를 복호화한다. 키 불일치·변조·길이 오류는 오류.
func Open(key, sealed []byte) ([]byte, error) {
	return nil, errNotImplemented
}
