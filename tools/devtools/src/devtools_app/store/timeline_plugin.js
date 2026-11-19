import { Plugin, signal, proxy, plugin } from "@odoo/owl";
import { StorePlugin, evalFunctionInWindow } from "./store";

// The newest events kept: a long recording drops its oldest.
const MAX_EVENTS = 20000;
const DEFAULT_CHANNELS = ["scheduler", "fiber", "lifecycle", "error"];

// The timeline: the page's owl debug channels, recorded while the panel asks
// (owl_devtools_global_hook.js, startTimeline).
export class TimelinePlugin extends Plugin {
  events = signal(proxy([]));
  recording = signal(false);
  channels = signal(null);
  selected = signal(proxy(new Set(DEFAULT_CHANNELS)));
  filter = signal("");

  setup() {
    this._store = plugin(StorePlugin);
  }

  async loadChannels() {
    const channels = await evalFunctionInWindow("getDebugChannels", [], this._store.activeFrame());
    this.channels.set(channels ?? null);
  }

  toggleChannel(channel) {
    const selected = this.selected();
    if (selected.has(channel)) {
      selected.delete(channel);
    } else {
      selected.add(channel);
    }
  }

  async toggleRecording() {
    const frame = this._store.activeFrame();
    if (this.recording()) {
      await evalFunctionInWindow("stopTimeline", [], frame);
      this.recording.set(false);
    } else {
      const started = await evalFunctionInWindow("startTimeline", [[...this.selected()]], frame);
      this.recording.set(Boolean(started));
    }
  }

  clear() {
    this.events.set(proxy([]));
  }

  load(batch) {
    const events = this.events();
    events.push(...batch);
    if (events.length > MAX_EVENTS) {
      events.splice(0, events.length - MAX_EVENTS);
    }
  }

  visibleEvents() {
    const filter = this.filter().toLowerCase();
    const events = this.events();
    return filter
      ? events.filter((event) => `${event.channel} ${event.message}`.toLowerCase().includes(filter))
      : events;
  }
}
