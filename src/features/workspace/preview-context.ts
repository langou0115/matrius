import { createContext, useContext } from 'react';

export const PreviewContext = createContext(false);
export function useIsPreview() { return useContext(PreviewContext); }
