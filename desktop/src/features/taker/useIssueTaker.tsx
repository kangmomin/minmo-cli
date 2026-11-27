import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'

import type { TakerEngine } from './engine'

export type TakerActions = Pick<TakerEngine, 'stop' | 'restart' | 'nextStep'>

const TakerActionsContext = createContext<TakerActions | null>(null)

export function useIssueTaker(): TakerActions | null {
  return null
}

export function TakerActionsProvider({ value, children }: { value: TakerActions | null; children: ReactNode }) {
  return <TakerActionsContext.Provider value={value}>{children}</TakerActionsContext.Provider>
}

export function useTakerActions(): TakerActions | null {
  return useContext(TakerActionsContext)
}
