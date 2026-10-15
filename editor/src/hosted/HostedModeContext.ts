import { createContext } from 'react';
import type { Capabilities, EditorAssetAdapter } from './bridge';
export const HostedModeContext = createContext<(Capabilities & { assets?: EditorAssetAdapter }) | null>(null);
