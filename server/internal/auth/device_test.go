package auth_test

import (
	"testing"
	"time"

	"github.com/kangmomin/minmo-cli/server/internal/auth"
)

type clock struct{ now time.Time }

func (c *clock) Now() time.Time { return c.now }

func newDeviceStore() (*auth.DeviceStore, *clock) {
	c := &clock{now: time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)}
	return auth.NewDeviceStore(c.Now), c
}

// 첫 확인은 바로 받고, 그 뒤에는 간격이 지나야 GitHub 에 묻게 한다
func TestDeviceStore_Interval(t *testing.T) {
	s, c := newDeviceStore()
	id, interval, err := s.Put(auth.DeviceCode{DeviceCode: "dc-1", ExpiresIn: 900, Interval: 5})
	if err != nil || id == "" || interval != 5 {
		t.Fatalf("Put: %q %d %v", id, interval, err)
	}
	state, code, sec := s.Begin(id)
	if state != auth.PollReady || code != "dc-1" || sec != 5 {
		t.Fatalf("first Begin: %v %q %d", state, code, sec)
	}
	// 확인이 끝나기 전의 다른 요청은 기다리게 한다(같은 코드를 동시에 두 번 묻지 않는다)
	if state, code, _ = s.Begin(id); state != auth.PollWait || code != "" {
		t.Errorf("concurrent Begin: %v %q", state, code)
	}
	if next := s.Finish(id, false, false, 0); next != 5 {
		t.Errorf("Finish interval = %d", next)
	}
	c.now = c.now.Add(4 * time.Second)
	if state, _, _ = s.Begin(id); state != auth.PollWait {
		t.Errorf("Begin before interval: %v", state)
	}
	c.now = c.now.Add(time.Second)
	if state, _, _ = s.Begin(id); state != auth.PollReady {
		t.Errorf("Begin after interval: %v", state)
	}
}

// slow_down: 5초를 더하고, GitHub 가 준 간격이 더 길면 그 값을 쓴다
func TestDeviceStore_SlowDown(t *testing.T) {
	s, _ := newDeviceStore()
	id, _, _ := s.Put(auth.DeviceCode{DeviceCode: "dc", ExpiresIn: 900, Interval: 5})
	s.Begin(id)
	if next := s.Finish(id, false, true, 0); next != 10 {
		t.Errorf("slow_down without interval = %d, want 10", next)
	}
	s2, _ := newDeviceStore()
	id2, _, _ := s2.Put(auth.DeviceCode{DeviceCode: "dc", ExpiresIn: 900, Interval: 5})
	s2.Begin(id2)
	if next := s2.Finish(id2, false, true, 30); next != 30 {
		t.Errorf("slow_down with interval = %d, want 30", next)
	}
}

// 만료·완료된 로그인과 모르는 id 는 없는 것으로 본다. 간격이 없으면 기본 5초
func TestDeviceStore_ExpiryAndDone(t *testing.T) {
	s, c := newDeviceStore()
	id, interval, _ := s.Put(auth.DeviceCode{DeviceCode: "dc", ExpiresIn: 60})
	if interval != 5 {
		t.Errorf("default interval = %d", interval)
	}
	c.now = c.now.Add(59 * time.Second)
	if state, _, _ := s.Begin(id); state != auth.PollReady {
		t.Fatalf("before expiry: %v", state)
	}
	s.Finish(id, false, false, 0)
	c.now = c.now.Add(time.Second)
	if state, _, _ := s.Begin(id); state != auth.PollGone {
		t.Errorf("at expiry: %v", state)
	}

	id2, _, _ := s.Put(auth.DeviceCode{DeviceCode: "dc2", ExpiresIn: 900, Interval: 1})
	s.Begin(id2)
	s.Finish(id2, true, false, 0)
	if state, _, _ := s.Begin(id2); state != auth.PollGone {
		t.Errorf("after done: %v", state)
	}
	if state, _, _ := s.Begin("unknown"); state != auth.PollGone {
		t.Errorf("unknown id: %v", state)
	}
	// 끝난 뒤의 Finish 는 아무 일도 하지 않는다
	if next := s.Finish(id2, false, false, 0); next != 0 {
		t.Errorf("Finish on removed = %d", next)
	}
}

// 상한 1,000 — 넘으면 가장 오래된 것부터 지운다. deviceId 는 매번 다르다
func TestDeviceStore_Cap(t *testing.T) {
	s, _ := newDeviceStore()
	first, _, _ := s.Put(auth.DeviceCode{DeviceCode: "first", ExpiresIn: 900, Interval: 1})
	seen := map[string]bool{first: true}
	for i := 0; i < 1000; i++ {
		id, _, _ := s.Put(auth.DeviceCode{DeviceCode: "x", ExpiresIn: 900, Interval: 1})
		if seen[id] {
			t.Fatalf("deviceId repeated: %q", id)
		}
		seen[id] = true
	}
	if state, _, _ := s.Begin(first); state != auth.PollGone {
		t.Errorf("oldest should be evicted: %v", state)
	}
}
