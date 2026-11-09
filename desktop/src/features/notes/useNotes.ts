export type NotesSaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; updatedAt: string | null }
  | { kind: 'failed'; code: string }

export type NotesConflict = { body: string; updatedAt: string | null }

export const NOTES_DEBOUNCE_MS = 1000
export const NOTES_MAX_BYTES = 1_048_576

// STUB (Phase 6.1 Red): 디바운스·단일 in-flight·baseUpdatedAt·409 흡수·401 초안 보존
export function useNotes(
  _owner: string,
  _repo: string,
  _key: string,
): {
  body: string
  setBody(body: string): void
  saveState: NotesSaveState
  conflict: NotesConflict | null
  loadServer(): void
  overwrite(): void
  disabled: boolean
  isLoading: boolean
} {
  throw new Error('not implemented')
}
