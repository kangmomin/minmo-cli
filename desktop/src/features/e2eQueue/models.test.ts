// 모델 목록 원문(agentModelsRaw) 파싱 — 실제 CLI 출력 형식을 줄여 쓴 입력
import { describe, expect, it } from 'vitest'

import { CLAUDE_ALIASES, parseClaudeCatalog, parseCodexModels, parseGeminiModels } from './models'

const ids = (list: { id: string }[]) => list.map((m) => m.id)

describe('parseClaudeCatalog', () => {
  const raw = JSON.stringify({
    catalog: {
      version: 2,
      catalog: {
        surface: 'cc',
        config: {
          id: 'cc',
          models: [
            { id: 'claude-opus-5-5', name: 'Opus 5.5', short_name: 'Opus', section: 'main' },
            { id: 'claude-mythos-5-2', name: 'Mythos 5.2', section: 'main' },
            { id: 'claude-sonnet-5', name: 'Sonnet 5', section: 'main' },
          ],
        },
      },
    },
    masked: { version: 1, ids: ['claude-mythos-5-2'] },
  })

  // AC-11
  it('AC-11 catalog 의 모델(id·이름)을 masked 의 id 를 빼고 돌려준다', () => {
    expect(parseClaudeCatalog(raw)).toEqual([
      { id: 'claude-opus-5-5', name: 'Opus 5.5' },
      { id: 'claude-sonnet-5', name: 'Sonnet 5' },
    ])
  })

  // AC-11 — masked 없음
  it('AC-11 masked 가 없으면 모두 돌려준다', () => {
    const noMask = JSON.stringify({ ...JSON.parse(raw), masked: null })
    expect(ids(parseClaudeCatalog(noMask))).toEqual(['claude-opus-5-5', 'claude-mythos-5-2', 'claude-sonnet-5'])
  })

  // AC-11 — 캐시가 없으면 별칭
  it('AC-11 캐시가 없으면(빈 원문) 별칭 opus·sonnet·haiku', () => {
    expect(ids(CLAUDE_ALIASES)).toEqual(['opus', 'sonnet', 'haiku'])
    expect(parseClaudeCatalog('')).toEqual(CLAUDE_ALIASES)
    expect(parseClaudeCatalog(JSON.stringify({ catalog: null, masked: null }))).toEqual(CLAUDE_ALIASES)
  })
})

describe('parseCodexModels', () => {
  const raw = JSON.stringify({
    models: [
      { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 1 },
      { slug: 'gpt-5.1-codex', display_name: 'GPT-5.1-Codex', visibility: 'list', priority: 5 },
      { slug: 'gpt-5.1', display_name: 'GPT-5.1', visibility: 'list', priority: 2 },
      { slug: 'gpt-5.1-mini', display_name: 'GPT-5.1-Mini', visibility: 'list', priority: 9 },
    ],
  })

  // AC-11
  it('AC-11 visibility 가 list 인 모델만, priority 순으로', () => {
    expect(parseCodexModels(raw)).toEqual([
      { id: 'gpt-5.1', name: 'GPT-5.1' },
      { id: 'gpt-5.1-codex', name: 'GPT-5.1-Codex' },
      { id: 'gpt-5.1-mini', name: 'GPT-5.1-Mini' },
    ])
  })

  // EC-06
  it('EC-06 파싱할 수 없는 출력만 오류(화면이 오류 문구를 보이고 직접 입력을 받는다) — 정상 출력은 읽는다', () => {
    expect(ids(parseCodexModels(raw))).toHaveLength(3)
    expect(() => parseCodexModels('error: unknown command `debug`')).toThrow()
  })
})

describe('parseGeminiModels', () => {
  // AC-11 — JSON(`models list -o json`)
  it('AC-11 JSON 출력: id 또는 modelId, displayName', () => {
    const raw = JSON.stringify([
      { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
      { modelId: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash' },
    ])
    expect(parseGeminiModels(raw)).toEqual([
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
    ])
  })

  // AC-11 — 텍스트(`--list-models`)
  it('AC-11 텍스트 출력: "id (이름)" 줄만 모델로 읽고, 머리말·들여쓴 설명 줄은 건너뛴다', () => {
    const raw = [
      'Available Gemini Models:',
      '',
      'auto (Auto)',
      '  Description:   Let Gemini CLI decide the best model for the task: gemini-2.5-pro, gemini-3.5-flash',
      '  Context limit: 1,048,576 input tokens / 8,192 output tokens',
      '',
      'gemini-2.5-pro (gemini-2.5-pro)',
      '  Context limit: 1,048,576 input tokens / 8,192 output tokens',
      '',
      'gemini-3.1-flash-lite (Gemini 3.1 Flash Lite)',
      '  Context limit: 1,048,576 input tokens / 8,192 output tokens',
      '',
    ].join('\n')
    expect(parseGeminiModels(raw)).toEqual([
      { id: 'auto', name: 'Auto' },
      { id: 'gemini-2.5-pro', name: 'gemini-2.5-pro' },
      { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite' },
    ])
  })

  // EC-06
  it('EC-06 모델을 하나도 읽지 못하면 오류 — 정상 출력은 읽는다', () => {
    expect(ids(parseGeminiModels('Available Gemini Models:\n\ngemini-2.5-pro (Gemini 2.5 Pro)\n'))).toEqual(['gemini-2.5-pro'])
    expect(() => parseGeminiModels('Unknown argument: list-models')).toThrow()
  })
})
