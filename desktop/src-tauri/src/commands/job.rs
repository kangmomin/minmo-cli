// Windows Job Object(KILL_ON_JOB_CLOSE) — PTY 셸과 내장 서버를 넣어, 앱이 비정상 종료해도 핸들이 닫히며
// 함께 끝나게 한다. 셸이 이후에 띄운 프로세스도 같은 Job 에 속해 부모 체인이 끊긴 자손까지 한 번에 끝낼 수 있다.
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

pub struct Job(HANDLE);

// HANDLE 은 프로세스 전역 커널 객체 핸들이라 스레드 간 이동·공유해도 안전하다
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Job {
    pub fn for_process(pid: u32) -> Option<Job> {
        // SAFETY: 각 호출의 반환값을 검사하고, 실패 경로에서 만든 핸들은 모두 닫는다
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return None;
            }
            let job = Job(handle);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if set == 0 {
                return None;
            }
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                return None;
            }
            let assigned = AssignProcessToJobObject(job.0, process);
            CloseHandle(process);
            (assigned != 0).then_some(job)
        }
    }

    pub fn terminate(&self) {
        // SAFETY: self.0 은 for_process 가 만든 유효한 Job 핸들이다
        unsafe {
            TerminateJobObject(self.0, 1);
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: 이 Job 이 소유한 핸들을 한 번만 닫는다
        unsafe {
            CloseHandle(self.0);
        }
    }
}
