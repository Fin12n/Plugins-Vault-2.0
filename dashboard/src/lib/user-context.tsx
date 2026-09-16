import { createContext, useContext } from 'react';
import type { SessionUser } from './api-client.js';

export const UserContext = createContext<SessionUser | null>(null);

export function useCurrentUser(): SessionUser | null {
  return useContext(UserContext);
}
