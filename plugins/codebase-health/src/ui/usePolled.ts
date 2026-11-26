import { useEffect, useState } from "react";

export const POLL_MS = 60_000;

/** The backend syncs on its own interval, so an open view re-reads or it shows what was true at mount. */
export function usePolled<T>(load: () => Promise<T>) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    const read = async () => {
      try {
        const next = await load();
        if (!current) return;
        setValue(next);
        setError(null);
      } catch (cause) {
        if (current) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void read();
    const poll = setInterval(() => void read(), POLL_MS);
    return () => {
      current = false;
      clearInterval(poll);
    };
  }, [load]);
  return { value, error };
}
