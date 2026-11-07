import { useEffect, useState, type DependencyList } from 'react';

interface AsyncState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
}

export function useAsync<T>(
  loader: () => Promise<T>,
  deps: DependencyList,
): AsyncState<T> & { reload: () => void; setData: (value: T) => void } {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    error: null,
    loading: true,
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState((previous) => ({ ...previous, loading: true, error: null }));
    loader()
      .then((data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ data: null, error, loading: false });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return {
    ...state,
    reload: () => setTick((value) => value + 1),
    setData: (value: T) =>
      setState({ data: value, error: null, loading: false }),
  };
}
