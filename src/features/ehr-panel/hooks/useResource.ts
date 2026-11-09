"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadResource, type ResourceState } from "./resource";

/** Loads data for `key`, reloading when it changes. Exposes `reload` for retry buttons. */
export function useResource<T>(key: string | undefined, load: (key: string) => Promise<T>, fallback: string) {
  const [state, setState] = useState<ResourceState<T>>({ status: "loading" });
  const generation = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const run = useCallback(() => {
    if (!key) return;
    const g = ++generation.current;
    void loadResource(() => loadRef.current(key), setState, fallback, () => g === generation.current);
  }, [key, fallback]);

  useEffect(() => {
    run();
    return () => {
      generation.current++;
    };
  }, [run]);

  return { state, reload: run };
}
