// Package auth 는 GitHub 기기 코드 로그인·세션·토큰 암호화를 담당한다.
package auth

import (
	"container/list"
	"crypto/rand"
	"encoding/base64"
	"sync"
	"time"
)

const (
	deviceCap = 1000
	// GitHub 가 간격을 주지 않았을 때의 기본 확인 간격(GitHub 의 기본값과 같다)
	defaultDeviceInterval = 5 * time.Second
	// slow_down 을 받으면 간격을 이만큼 늘린다(RFC 8628 §3.5)
	slowDownStep = 5 * time.Second
)

// randomURLToken 은 n 바이트 난수의 base64url(패딩 없음) 문자열이다.
func randomURLToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// PendingDevice 는 진행 중인 기기 코드 로그인이다.
type PendingDevice struct {
	id         string
	DeviceCode string
	expiresAt  time.Time
	interval   time.Duration
	// nextPoll 이전에는 GitHub 에 묻지 않는다 — 너무 자주 물으면 GitHub 가 slow_down 으로 간격을 늘린다
	nextPoll time.Time
	// busy 는 이 로그인의 확인 요청이 GitHub 응답을 기다리는 중임을 뜻한다(같은 코드를 동시에 두 번 묻지 않는다)
	busy bool
}

// DeviceStore 는 deviceId → GitHub device_code 를 메모리에 보관한다(만료 시 제거, 상한 1,000 — 초과 시 최고령 제거).
// device_code 는 토큰과 바꿀 수 있는 값이라 클라이언트에 내주지 않고, 임의의 deviceId 로만 가리킨다.
// 단일 서버 인스턴스 전제 — 재시작하면 진행 중이던 로그인은 처음부터 다시 한다.
type DeviceStore struct {
	mu    sync.Mutex
	now   func() time.Time
	order *list.List // 삽입 순(최고령이 Front)
	byID  map[string]*list.Element
}

// NewDeviceStore 는 now 주입 시계를 쓰는 DeviceStore 를 만든다.
func NewDeviceStore(now func() time.Time) *DeviceStore {
	return &DeviceStore{now: now, order: list.New(), byID: map[string]*list.Element{}}
}

// Put 은 발급받은 기기 코드를 저장하고 deviceId 와 확인 간격(초)을 돌려준다.
func (s *DeviceStore) Put(dc DeviceCode) (id string, intervalSec int, err error) {
	id, err = randomURLToken(32)
	if err != nil {
		return "", 0, err
	}
	interval := time.Duration(dc.Interval) * time.Second
	if interval <= 0 {
		interval = defaultDeviceInterval
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	s.purgeExpired(now)
	for s.order.Len() >= deviceCap {
		s.remove(s.order.Front())
	}
	// 첫 확인은 바로 받아 준다(클라이언트가 간격을 두고 처음 묻는다) — 그 뒤부터 간격을 지킨다
	p := &PendingDevice{id: id, DeviceCode: dc.DeviceCode, expiresAt: now.Add(time.Duration(dc.ExpiresIn) * time.Second), interval: interval, nextPoll: now}
	s.byID[id] = s.order.PushBack(p)
	return id, int(interval / time.Second), nil
}

// PollState 는 Begin 의 결과다.
type PollState int

const (
	// PollGone: 모르는 id 이거나 만료됨
	PollGone PollState = iota
	// PollWait: 아직 확인할 때가 아니거나 다른 확인이 진행 중 — GitHub 에 묻지 않고 "대기"로 답한다
	PollWait
	// PollReady: GitHub 에 물어도 된다. 끝나면 반드시 Finish 를 부른다
	PollReady
)

// Begin 은 id 의 확인을 시작한다. PollReady 면 device_code 를, 그 밖에는 현재 간격(초)만 돌려준다.
func (s *DeviceStore) Begin(id string) (state PollState, deviceCode string, intervalSec int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	el, ok := s.byID[id]
	if !ok {
		return PollGone, "", 0
	}
	p := el.Value.(*PendingDevice)
	now := s.now()
	if !now.Before(p.expiresAt) {
		s.remove(el)
		return PollGone, "", 0
	}
	sec := int(p.interval / time.Second)
	if p.busy || now.Before(p.nextPoll) {
		return PollWait, "", sec
	}
	p.busy = true
	return PollReady, p.DeviceCode, sec
}

// Finish 는 Begin(PollReady) 뒤의 결과를 반영한다. done 이면(성공·만료·거부) 지우고,
// 아니면 다음 확인 시각을 잡는다 — slowDown 이면 간격을 늘린다(newIntervalSec 이 있으면 그 값 이상으로).
// 돌려주는 값은 다음 확인까지의 간격(초)이다.
func (s *DeviceStore) Finish(id string, done, slowDown bool, newIntervalSec int) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	el, ok := s.byID[id]
	if !ok {
		return 0
	}
	p := el.Value.(*PendingDevice)
	if done {
		s.remove(el)
		return 0
	}
	p.busy = false
	if slowDown {
		p.interval += slowDownStep
		if given := time.Duration(newIntervalSec) * time.Second; given > p.interval {
			p.interval = given
		}
	}
	p.nextPoll = s.now().Add(p.interval)
	return int(p.interval / time.Second)
}

func (s *DeviceStore) purgeExpired(now time.Time) {
	// 만료 시각은 삽입 순서와 같지 않을 수 있어 전체를 본다(상한 1,000)
	for el := s.order.Front(); el != nil; {
		next := el.Next()
		if !now.Before(el.Value.(*PendingDevice).expiresAt) {
			s.remove(el)
		}
		el = next
	}
}

func (s *DeviceStore) remove(el *list.Element) {
	delete(s.byID, el.Value.(*PendingDevice).id)
	s.order.Remove(el)
}
