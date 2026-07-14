import { useSyncExternalStore } from 'react'
import { createStore } from '../../node_modules/zustand/esm/vanilla.mjs'

import type { WorkflowData } from '../types/workflow'

export type PlaybackSpeed = 0.5 | 1 | 2 | 4

export interface WorkflowStore {
  workflow: WorkflowData | null
  selectedNodeId: string | null
  currentTime: number
  duration: number
  isPlaying: boolean
  playbackSpeed: PlaybackSpeed
  setWorkflow: (workflow: WorkflowData) => void
  clearWorkflow: () => void
  selectNode: (nodeId: string | null) => void
  setCurrentTime: (time: number) => void
  setPlaying: (playing: boolean) => void
  togglePlaying: () => void
  setPlaybackSpeed: (speed: PlaybackSpeed) => void
  resetPlayback: () => void
}

const playbackSpeeds = new Set<PlaybackSpeed>([0.5, 1, 2, 4])

const workflowStore = createStore<WorkflowStore>((set) => ({
  workflow: null,
  selectedNodeId: null,
  currentTime: 0,
  duration: 0,
  isPlaying: false,
  playbackSpeed: 1,
  setWorkflow: (workflow) =>
    set({
      workflow,
      duration: workflow.duration,
      currentTime: 0,
      selectedNodeId: null,
      isPlaying: false,
    }),
  clearWorkflow: () =>
    set({
      workflow: null,
      selectedNodeId: null,
      currentTime: 0,
      duration: 0,
      isPlaying: false,
      playbackSpeed: 1,
    }),
  selectNode: (selectedNodeId) => set({ selectedNodeId }),
  setCurrentTime: (time) =>
    set((state) => ({
      currentTime: Math.min(state.duration, Math.max(0, Number.isFinite(time) ? time : 0)),
    })),
  setPlaying: (isPlaying) => set({ isPlaying }),
  togglePlaying: () => set((state) => ({ isPlaying: !state.isPlaying })),
  setPlaybackSpeed: (playbackSpeed) => {
    if (playbackSpeeds.has(playbackSpeed)) set({ playbackSpeed })
  },
  resetPlayback: () => set({ currentTime: 0, isPlaying: false }),
}))

interface WorkflowStoreHook {
  (): WorkflowStore
  <Selection>(selector: (state: WorkflowStore) => Selection): Selection
  getState: typeof workflowStore.getState
  getInitialState: typeof workflowStore.getInitialState
  setState: typeof workflowStore.setState
  subscribe: typeof workflowStore.subscribe
}

function useWorkflowStoreHook<Selection = WorkflowStore>(
  selector: (state: WorkflowStore) => Selection = (state) => state as Selection,
): Selection {
  return useSyncExternalStore(
    workflowStore.subscribe,
    () => selector(workflowStore.getState()),
    () => selector(workflowStore.getInitialState()),
  )
}

export const useWorkflowStore = Object.assign(useWorkflowStoreHook, workflowStore) as WorkflowStoreHook
