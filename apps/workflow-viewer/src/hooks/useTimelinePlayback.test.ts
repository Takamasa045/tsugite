import { describe, expect, it } from 'vitest'

import { calculatePlaybackStep } from './useTimelinePlayback'

describe('calculatePlaybackStep', () => {
  it('経過時間と再生速度から次時刻を求める', () => {
    expect(calculatePlaybackStep(10, 0.5, 2, 60)).toEqual({ time: 11, finished: false })
  })

  it('終端で停止しdurationを超えない', () => {
    expect(calculatePlaybackStep(59.5, 1, 4, 60)).toEqual({ time: 60, finished: true })
  })

  it('不正値と負値を安全に補正する', () => {
    expect(calculatePlaybackStep(-10, Number.NaN, 1, 30)).toEqual({
      time: 0,
      finished: false,
    })
  })
})
