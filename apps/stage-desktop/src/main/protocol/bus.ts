import { EventEmitter } from "node:events";
import type { ActionCommand, SensorUpdate, UserInteraction } from "@sama/shared";

export type BusEvents = {
  sensorUpdate: (u: SensorUpdate) => void;
  actionCommand: (c: ActionCommand) => void;
  userInteraction: (i: UserInteraction) => void;
};

export class MainBus extends EventEmitter {
  emitSensorUpdate(u: SensorUpdate) {
    this.emit("sensorUpdate", u);
  }

  onSensorUpdate(handler: BusEvents["sensorUpdate"]) {
    this.on("sensorUpdate", handler);
    return () => this.off("sensorUpdate", handler);
  }

  emitActionCommand(c: ActionCommand) {
    this.emit("actionCommand", c);
  }

  onActionCommand(handler: BusEvents["actionCommand"]) {
    this.on("actionCommand", handler);
    return () => this.off("actionCommand", handler);
  }

  emitUserInteraction(i: UserInteraction) {
    this.emit("userInteraction", i);
  }

  onUserInteraction(handler: BusEvents["userInteraction"]) {
    this.on("userInteraction", handler);
    return () => this.off("userInteraction", handler);
  }
}

