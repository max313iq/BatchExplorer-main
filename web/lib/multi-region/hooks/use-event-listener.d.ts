export interface UseEventListenerOptions extends AddEventListenerOptions {
    /** Target to attach the listener to. Defaults to `window`. */
    target?: Window | Document | HTMLElement | EventTarget | null;
    /** Whether the listener is active. Default: true. */
    enabled?: boolean;
}
export declare function useEventListener<K extends keyof WindowEventMap>(type: K, handler: (event: WindowEventMap[K]) => void, options?: UseEventListenerOptions): void;
export declare function useEventListener<K extends keyof DocumentEventMap>(type: K, handler: (event: DocumentEventMap[K]) => void, options?: UseEventListenerOptions): void;
export declare function useEventListener<K extends keyof HTMLElementEventMap>(type: K, handler: (event: HTMLElementEventMap[K]) => void, options?: UseEventListenerOptions): void;
//# sourceMappingURL=use-event-listener.d.ts.map