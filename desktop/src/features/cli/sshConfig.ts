/** 이 PC(SSH 클라이언트)의 ~/.ssh/config 예시 — 서버(127.0.0.1:8787)를 원격 호스트의 Unix 소켓으로 역터널한다.
 *  TCP 포트 대신 소켓을 쓰는 이유: 원격의 다른 사용자가 같은 포트로 접근하거나 포트 충돌로 토큰이 엉뚱한 곳에 가지 않게 */
export const SSH_CONFIG_EXAMPLE = `Host my-server
  HostName <원격 주소>
  User <사용자>
  RemoteForward /home/<사용자>/.minmo/server.sock 127.0.0.1:8787
  ExitOnForwardFailure yes
  StreamLocalBindUnlink yes`
