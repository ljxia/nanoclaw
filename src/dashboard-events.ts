/**
 * Dashboard event bus — typed EventEmitter singleton for real-time dashboard updates.
 */
import { EventEmitter } from 'events';

import { QueueSnapshot } from './group-queue.js';

export interface ContainerStartEvent {
  group: string;
  groupFolder: string;
  containerName: string;
  isTask: boolean;
  timestamp: string;
}

export interface ContainerEndEvent {
  group: string;
  containerName: string;
  duration: number;
  exitCode: number | null;
  timestamp: string;
}

export interface AgentPhaseEvent {
  group: string;
  phase: 'initializing' | 'working' | 'responding' | 'idle';
  detail?: string;
  timestamp: string;
}

export interface AgentStreamEvent {
  group: string;
  entry: StreamEntry;
  timestamp: string;
}

export interface StreamEntry {
  kind: 'text' | 'tool_use' | 'tool_result' | 'result';
  tool?: string;
  content: string;
}

export interface DashboardEventMap {
  'container:start': ContainerStartEvent;
  'container:end': ContainerEndEvent;
  'agent:phase': AgentPhaseEvent;
  'agent:stream': AgentStreamEvent;
  'queue:update': QueueSnapshot;
}

class DashboardBus extends EventEmitter {
  emitEvent<K extends keyof DashboardEventMap>(
    event: K,
    data: DashboardEventMap[K],
  ): void {
    this.emit(event, data);
  }

  onEvent<K extends keyof DashboardEventMap>(
    event: K,
    listener: (data: DashboardEventMap[K]) => void,
  ): this {
    return this.on(event, listener);
  }
}

export const dashboardBus = new DashboardBus();
