import { useLayoutEffect, useRef } from 'react';

export function SplatViewer({ url }: { url: string }) {
  const iframe = useRef<HTMLIFrameElement>(null);
  useLayoutEffect(() => {
    const frame = iframe.current;
    return () => {
      const viewer = frame?.contentWindow as (Window & { disposeSplatViewer?: () => void }) | null;
      viewer?.disposeSplatViewer?.();
    };
  }, [url]);
  return <iframe ref={iframe} className="splat-viewer" title="Interactive splat viewer"
    src={`./splat/viewer.html?url=${encodeURIComponent(url)}`} />;
}
