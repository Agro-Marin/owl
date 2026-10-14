import { Component, mount, xml, signal, computed, useEffect } from "@odoo/owl";


class CanvasPaint extends Component {
    static template = xml`
        <p>click on the canvas to draw (<t t-out="this.numberOfDots()"/> dots)</p>
        <canvas t-ref="this.canvas"
            width="500" height="400"
            style="border:1px solid #333;"
            t-on-click="this.handleClick"/>`;

    points = signal.Array([]);
    canvas = signal.ref();
    numberOfDots = computed(() => this.points().length);

    setup() {
        useEffect(() => this.draw());
    }

    handleClick(ev) {
        const rect = this.canvas().getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const y = ev.clientY - rect.top;
        this.points().push({ x, y });
    }

    draw() {
        if (!this.canvas()) return;
        const ctx = this.canvas().getContext("2d");
        ctx.clearRect(0, 0, this.canvas().width, this.canvas().height);
        for (const pt of this.points()) {
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 10, 0, 2 * Math.PI);
            ctx.fillStyle = "cornflowerblue";
            ctx.fill();
            ctx.stroke();
        }
    }
}

mount(CanvasPaint, document.body, { templates: TEMPLATES, dev: true });
