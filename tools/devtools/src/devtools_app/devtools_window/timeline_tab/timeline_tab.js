import { Component, onWillStart, plugin } from "@odoo/owl";
import { TimelinePlugin } from "../../store/timeline_plugin";

export class TimelineTab extends Component {
  static template = "devtools.TimelineTab";

  setup() {
    this.timeline = plugin(TimelinePlugin);
    onWillStart(() => this.timeline.loadChannels());
  }

  // A scheduler frame starts a group: what follows ran in that frame.
  isFrame(event) {
    return event.channel === "scheduler" && event.message.startsWith("frame");
  }

  time(event) {
    return `${event.time.toFixed(1)} ms`;
  }
}
