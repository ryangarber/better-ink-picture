import { useStdout } from "ink";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { ImageClient, type ImageClientOptions } from "../core/client.ts";

const ImageContext = createContext<ImageClient | undefined>(undefined);

let fallbackClient: ImageClient | undefined;

/**
 * The image client for this tree: the provider's, or — with no provider — a
 * shared one that guesses the terminal from its environment.
 */
export const useImageClient = (): ImageClient => {
  const client = useContext(ImageContext);
  if (client) return client;
  fallbackClient ??= new ImageClient();
  return fallbackClient;
};

export type ImageProviderProps = Omit<ImageClientOptions, "stdout"> & { children?: ReactNode };

/**
 * Gives the images inside it one worker and what the terminal can do. Pass
 * `capabilities` from `await detectTerminal()`, run before Ink's `render()`;
 * without them, the terminal is guessed from its environment.
 *
 * On unmount, every image it put in the terminal is deleted.
 */
export function ImageProvider({ children, ...options }: ImageProviderProps) {
  const { stdout } = useStdout();
  const [client] = useState(() => new ImageClient({ ...options, stdout }));
  useEffect(() => () => client.dispose(), [client]);
  return <ImageContext.Provider value={client}>{children}</ImageContext.Provider>;
}
