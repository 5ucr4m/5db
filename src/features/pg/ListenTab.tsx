import { Antenna, Plus, Send, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, EmptyState, Input } from "../../components/ui";
import { clockTime, tryPrettyJson } from "../../lib/format";
import { errorMessage, rpc } from "../../lib/rpc";
import { type Session, useApp } from "../../store/app";

interface Notice {
  channel: string;
  payload: string;
  pid: number;
  at: string;
}

interface Feed {
  notices: Notice[];
  channels: string[];
}

/** Enough to look back over a burst without growing without end. */
const KEEP = 1000;

export function ListenTab({ session, active }: { session: Session; active: boolean }) {
  const toast = useApp((s) => s.toast);
  const [channels, setChannels] = useState<string[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [channel, setChannel] = useState("");
  // The sender keeps its own channel, so typing one to listen on does not
  // quietly change where a NOTIFY would go.
  const [sendTo, setSendTo] = useState("");
  const [payload, setPayload] = useState("");
  const [follow, setFollow] = useState(true);
  const log = useRef<HTMLDivElement>(null);

  const target = { connectionId: session.connectionId, database: session.database };

  const absorb = useCallback((feed: Feed) => {
    setChannels(feed.channels);
    if (feed.notices.length) setNotices((prev) => [...prev, ...feed.notices].slice(-KEEP));
  }, []);

  // The RPC surface is request/response, so the panel polls while it is on
  // screen. The backend buffers whatever arrived between two polls.
  useEffect(() => {
    if (!active) return;
    let stop = false;
    const tick = async () => {
      try {
        absorb(await rpc<Feed>("pg.notifications", target));
      } catch {
        // A poll that fails is not worth a toast; the next one will tell.
      }
      if (!stop) timer = setTimeout(tick, 1000);
    };
    let timer = setTimeout(tick, 0);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, session.connectionId, session.database, absorb]);

  useEffect(() => {
    if (follow) log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [notices, follow]);

  const call = async (method: string, params: Record<string, unknown>) => {
    try {
      absorb(await rpc<Feed>(method, { ...target, ...params }));
    } catch (e) {
      toast("error", errorMessage(e));
    }
  };

  // NOTIFY goes out on another connection and answers nothing: Postgres hands a
  // self-notification back inside the sending query, where the listener would
  // never see it. The next poll is what picks it up.
  const send = async (name: string) => {
    try {
      await rpc("pg.notify", { ...target, channel: name, payload });
    } catch (e) {
      toast("error", errorMessage(e));
    }
  };

  const listen = async () => {
    const name = channel.trim();
    if (!name) return;
    await call("pg.listen", { channel: name });
    setChannel("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <Antenna className="size-4 text-iris" />
        <h2 className="font-display text-[15px] font-semibold">Notifications</h2>
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void listen();
          }}
        >
          <Input
            mono
            className="h-7 w-56 text-xs"
            placeholder="channel to listen on"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
          />
          <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />} type="submit" disabled={!channel.trim()}>
            Listen
          </Button>
        </form>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-faint tabular">{notices.length ? `${notices.length} received` : "nothing yet"}</span>
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 className="size-3.5" />}
            onClick={() => setNotices([])}
            disabled={!notices.length}
          >
            Clear
          </Button>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        {channels.length === 0 ? (
          <span className="text-xs text-faint">Not listening on any channel.</span>
        ) : (
          channels.map((c) => (
            <Badge key={c} className="gap-1 font-mono">
              {c}
              <button
                type="button"
                className="text-faint hover:text-fg"
                aria-label={`Stop listening on ${c}`}
                onClick={() => void call("pg.unlisten", { channel: c })}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))
        )}
      </div>

      <div
        ref={log}
        className="selectable min-h-0 flex-1 overflow-auto"
        onScroll={() => {
          const el = log.current;
          if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
      >
        {notices.length === 0 ? (
          <EmptyState icon={<Antenna className="size-5" />} title="Listening for NOTIFY">
            <span>Everything sent to a channel you listen on shows up here, payload and all. Use the sender below to try one.</span>
          </EmptyState>
        ) : (
          <div className="divide-y divide-line/60">
            {notices.map((n, i) => {
              const pretty = tryPrettyJson(n.payload);
              return (
                <div key={`${n.at}-${i}`} className="px-4 py-2">
                  <div className="flex items-baseline gap-2 text-xs">
                    <span className="font-mono font-medium text-iris">{n.channel}</span>
                    <span className="text-faint tabular">{clockTime(n.at)}</span>
                    <span className="text-faint">pid {n.pid}</span>
                  </div>
                  {n.payload ? (
                    <pre className="mt-1 overflow-x-auto font-mono text-xs leading-relaxed text-fg">{pretty ?? n.payload}</pre>
                  ) : (
                    <div className="mt-1 text-xs text-faint">no payload</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <form
        className="flex shrink-0 items-center gap-1.5 border-t border-line px-4 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          const name = sendTo.trim() || channels[0];
          if (name) void send(name);
        }}
      >
        <span className="text-xs text-muted">Send to</span>
        <Input
          mono
          className="h-7 w-44 text-xs"
          placeholder={channels[0] ?? "channel"}
          value={sendTo}
          onChange={(e) => setSendTo(e.target.value)}
        />
        <Input
          mono
          className="h-7 flex-1 text-xs"
          placeholder="payload (optional)"
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
        />
        <Button
          size="sm"
          variant="secondary"
          icon={<Send className="size-3.5" />}
          type="submit"
          disabled={!sendTo.trim() && !channels.length}
        >
          Notify
        </Button>
      </form>
    </div>
  );
}
