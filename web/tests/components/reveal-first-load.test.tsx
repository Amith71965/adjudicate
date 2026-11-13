// @vitest-environment jsdom
/**
 * Speed (U5): a streamed Suspense reveal that carries view-transition markers makes React's
 * streaming runtime wrap the first paint in a document-wide view transition that waits for web
 * fonts and images (Lighthouse: LCP 3.2 s, 870 ms blocking on the case page). The skeleton-out /
 * reveal motion is for client navigations only, so the first, server-streamed load emits none.
 */
import { cleanup, render } from "@testing-library/react";
import { Suspense, use } from "react";
import { renderToReadableStream } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { Reveal, SkeletonExit, useHydrated } from "@/components/ui/page-transition";

afterEach(cleanup);

async function streamed(node: React.ReactNode): Promise<string> {
  const stream = await renderToReadableStream(node);
  await stream.allReady;
  return new Response(stream).text();
}

function Late({ data, children }: { data: Promise<string>; children: React.ReactNode }) {
  use(data);
  return <>{children}</>;
}

describe("first load", () => {
  it("streams the skeleton and the revealed content without view-transition markers", async () => {
    let resolve!: (v: string) => void;
    const data = new Promise<string>((r) => { resolve = r; });
    const pending = streamed(
      <Suspense fallback={<SkeletonExit><p>Loading</p></SkeletonExit>}>
        <Late data={data}><Reveal><div>The case</div></Reveal></Late>
      </Suspense>,
    );
    setTimeout(() => resolve("ok"), 10);
    const html = await pending;
    expect(html).toContain("The case");
    expect(html).not.toMatch(/vt-(enter|exit)=/);
  });
});

describe("after hydration", () => {
  it("knows it is on the client, so later reveals animate", () => {
    function Probe() { return <p>{useHydrated() ? "client" : "server"}</p>; }
    const { container } = render(<Probe />);
    expect(container.textContent).toBe("client");
  });
});
