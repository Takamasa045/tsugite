import { useEffect } from 'react'

import { useWorkflowStore } from '../store/workflow-store'

interface PlaybackStep {
  time: number
  finished: boolean
}

export function calculatePlaybackStep(
  currentTime: number,
  elapsedSeconds: number,
  playbackSpeed: number,
  duration: number,
): PlaybackStep {
  const safeDuration = Math.max(0, Number.isFinite(duration) ? duration : 0)
  const safeCurrentTime = Math.min(
    safeDuration,
    Math.max(0, Number.isFinite(currentTime) ? currentTime : 0),
  )
  const safeElapsed = Math.max(0, Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0)
  const safeSpeed = Math.max(0, Number.isFinite(playbackSpeed) ? playbackSpeed : 0)
  const time = Math.min(safeDuration, safeCurrentTime + safeElapsed * safeSpeed)

  return { time, finished: safeDuration > 0 && time >= safeDuration }
}

export function useTimelinePlayback(): void {
  const isPlaying = useWorkflowStore((state) => state.isPlaying)

  useEffect(() => {
    if (!isPlaying) return

    let animationFrame = 0
    let previousTimestamp = performance.now()

    const advance = (timestamp: number) => {
      const state = useWorkflowStore.getState()
      if (!state.isPlaying) return

      const elapsedSeconds = Math.max(0, timestamp - previousTimestamp) / 1000
      previousTimestamp = timestamp
      const next = calculatePlaybackStep(
        state.currentTime,
        elapsedSeconds,
        state.playbackSpeed,
        state.duration,
      )
      state.setCurrentTime(next.time)

      if (next.finished) {
        state.setPlaying(false)
        return
      }
      animationFrame = requestAnimationFrame(advance)
    }

    animationFrame = requestAnimationFrame(advance)
    return () => cancelAnimationFrame(animationFrame)
  }, [isPlaying])
}
