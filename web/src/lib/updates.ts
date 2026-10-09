import { useEffect } from "react";
import { create } from "zustand";
import type { UpdateInfo } from "../../../shared/api";
import { api } from "./api";

interface UpdateState {
  info: UpdateInfo | null;
  checking: boolean;
  /** Resolves true when the server answered. */
  refresh: (force?: boolean) => Promise<boolean>;
}

export const useUpdates = create<UpdateState>((set, get) => ({
  info: null,
  checking: false,
  refresh: async (force = false) => {
    if (get().checking) return true;
    set({ checking: true });
    try {
      set({ info: await api.update(force) });
      return true;
    } catch {
      // Best effort; the footer just stays quiet.
      return false;
    } finally {
      set({ checking: false });
    }
  },
}));

const POLL_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;

/**
 * Asks the server on load and then hourly (the server caches GitHub's answer for an
 * hour). If the server could not be reached, tries again after a minute.
 */
export function useUpdatePolling(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      const ok = await useUpdates.getState().refresh();
      if (!stopped) timer = setTimeout(() => void tick(), ok ? POLL_MS : RETRY_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
}

/** The command that replaces the running container with the newest image (matches the README). */
export const CONTAINER_UPDATE_COMMAND = [
  "docker pull ghcr.io/piyushdoorwar/yamlet:latest",
  "docker rm -f yamlet",
  "docker run -d --pull always --name yamlet -p 127.0.0.1:7878:7878 -v .:/workspace -v yamlet-data:/data ghcr.io/piyushdoorwar/yamlet",
].join("\n");
