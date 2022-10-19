const Main = imports.ui.main;
const GLib = imports.gi.GLib;
const Clutter = imports.gi.Clutter;
const Meta = imports.gi.Meta;
const Signals = imports.signals;
const Lang = imports.lang;
const ExtensionUtils = imports.misc.extensionUtils;

const EDGE_THRESHOLD = 48;

const SnapAction = {
    NONE: 0,
    MAXIMIZE: 1,
    TILE_LEFT: 2,
    TILE_RIGHT: 4
};

let swapGesturesHandler = null;
let gestureHandler = null;

const TouchpadGestureAction = class{

    constructor(stage, wm, display) {

        const seat = Clutter.get_default_backend().get_default_seat();
        this._virtualTouchpad = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        this._virtualKeyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._stageCapturedEventCallbackID = stage.connect('captured-event::touchpad', this._handleEvent.bind(this));
        this._windowsManagerSizeChangedCallbackID = wm.connect('size-changed', this._onWMSizeChanged.bind(this));
        this._displayGrabOpBeginCallbackID = display.connect('grab-op-begin', this._onBeginGrabOp.bind(this));
        this._displayGrabOpEndCallbackID = display.connect('grab-op-end', this._onEndGrabOp.bind(this));

        this._stage = stage;
        this._wm = wm;
        this._display = display;

        this._onGesture = false;
        this._onGrabOp = false;
        this._monitorGeometry = null;
        this._posRect = new Meta.Rectangle({x:0, y:0, width: 1, height: 1});
        this._previewRect = new Meta.Rectangle({x:0, y:0, width: 0, height: 0});

        this._movingMetaWindow = null;
        this._pointerWindowDiffX = 0;
        this._pointerWindowDiffY = 0;
        this._pointerDiffX = 0;
        this._pointerDiffY = 0;
        this._nextSnapAction = SnapAction.NONE;

        this._sizeHandler = null;
        this._unmanagedHandler = null;
        this._workspaceChangedHandler = null;
      
        this._settings = ExtensionUtils.getSettings('org.gnome.shell.extensions.touchpad-swap-finger-gestures-with-windows-move');
        this._settingsChangedCallbackID = this._settings.connect('changed', Lang.bind(this, this._updateSettings));
        this._updateSettings();
    }
    
    _updateSettings() {
        this._acceleration = this._settings.get_double('acceleration');
        this._thresholdSquare = this._settings.get_int('threshold');
        this._thresholdSquare *= this._thresholdSquare;
        this._summarizeThreshold = this._settings.get_boolean('summarize-threshold');
    }

    _handleEvent(actor, event) {
        // Only look for touchpad swipes
        if (event.type() != Clutter.EventType.TOUCHPAD_SWIPE)
            return Clutter.EVENT_PROPAGATE;

        // Only look for three finger gestures
        if (event.get_touchpad_gesture_finger_count() != 3)
            return Clutter.EVENT_PROPAGATE;

        // Handle event
        switch (event.get_gesture_phase()) {
            case Clutter.TouchpadGesturePhase.BEGIN:
                this._onGesture = true;
                return this._gestureStarted();

            case Clutter.TouchpadGesturePhase.UPDATE:
                let [dx, dy] = event.get_gesture_motion_delta();
                return this._gestureUpdate(dx, dy);

            default: //CANCEL or END
                this._onGesture = false;
                return this._gestureEnd();
        }

        return Clutter.EVENT_STOP;

    }

    _onBeginGrabOp(display, window, op) {

        log(`BeginGrab: op=${op}`);
        log(`BeginGrab: _onGrabOp=${this._onGrabOp}`);
        log(`BeginGrab: _onGesture=${this._onGesture}`);
        if (op == Meta.GrabOp.MOVING) {
          this._onGrabOp = true;
          this._gestureStarted_win();
        }
        const currentTime = GLib.get_monotonic_time();
        this._virtualTouchpad.notify_button(currentTime, 1, Clutter.ButtonState.RELEASED);
    }

    _onEndGrabOp(display, window, op) {

        log(`EndGrab: op=${op}`);
        log(`EndGrab: _onGrabOp=${this._onGrabOp}`);
        log(`EndGrab: _onGesture=${this._onGesture}`);
        if (!this._onGesture) {
            const currentTime = GLib.get_monotonic_time();
            this._virtualTouchpad.notify_button(currentTime, 1, Clutter.ButtonState.RELEASED);
            this._onGrabOp = false;
        }
    }

    _onWMSizeChanged(display, actor) {
        log(`VMSizeChanged`);
    }

    _gestureStarted() {

        const currentTime = GLib.get_monotonic_time();
        this._virtualTouchpad.notify_button(currentTime, 1, Clutter.ButtonState.PRESSED);

        return Clutter.EVENT_STOP;
    }

    _gestureUpdate(dx, dy) {

        log(`gestureUpdate: dx,dy=${dx},${dy}`);
        log(`gestureUpdate: _onGrabOp=${this._onGrabOp}`);
        log(`gestureUpdate: _onGesture=${this._onGesture}`);
        if (!this._onGrabOp) {
            const currentTime = GLib.get_monotonic_time();
            this._virtualTouchpad.notify_relative_motion(currentTime, dx, dy);

            return Clutter.EVENT_STOP;
        } else {
            return this._gestureUpdate_win(dx, dy);
        }
    }

    _gestureEnd() {

        const currentTime = GLib.get_monotonic_time();
        this._virtualTouchpad.notify_button(currentTime, 1, Clutter.ButtonState.RELEASED);

        if (!this._onGrabOp) {
            return Clutter.EVENT_STOP;
        } else {
            this._onGrabOp = false;
            return this._gestureEnd_win();
        }
    }

    _gestureStarted_win() {

        let [pointerX, pointerY, pointerZ] = global.get_pointer();
        const windowClutterActor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, pointerX, pointerY).get_parent();

        // Do not reply on gestures, if pointer is not on top of a window
        if (!windowClutterActor.get_meta_window) {
                return Clutter.EVENT_PROPAGATE;
        }

        this._movingMetaWindow = windowClutterActor.get_meta_window();
        // take window below, if it is attached
        if (this._movingMetaWindow.is_attached_dialog())
            this._movingMetaWindow = this._movingMetaWindow.get_transient_for();


        // Don't do anything, if window move is not allowed
        if (!this._movingMetaWindow.allows_move())
            return Clutter.EVENT_PROPAGATE;

        // Calculate workspace data
        this._monitorGeometry = this._movingMetaWindow.get_work_area_current_monitor();
        this._posRect.x = pointerX;
        this._posRect.y = pointerY;
        this._monitorIndex = global.display.get_monitor_index_for_rect(this._posRect);

        // End gesture if window is closed
        const outerThis = this;
        this._unmanagedHandler = this._movingMetaWindow.connect('unmanaged', function() {
            outerThis._movingMetaWindow.disconnect(outerThis._unmanagedHandler);
            outerThis._movingMetaWindow.disconnect(outerThis._sizeHandler);
            outerThis._unmanagedHandler = null;
            outerThis._sizeHandler = null;

            outerThis._movingMetaWindow = null;
            outerThis._nextSnapAction = SnapAction.NONE;
        });

        // Connect to workspace-changed
        this._workspaceChangedHandler = this._movingMetaWindow.connect('workspace-changed', function() {
            outerThis._monitorGeometry = outerThis._movingMetaWindow.get_work_area_current_monitor();
            [pointerX, pointerY, pointerZ] >= global.get_pointer();
            outerThis._posRect.x = pointerX;
            outerThis._posRect.y = pointerY;
            outerThis._monitorIndex = global.display.get_monitor_index_for_rect(outerThis._posRect);
        });

        // Handle maximized window
        if (this._movingMetaWindow.get_maximized() != 0) {

            // Activate window
            const currentTime = GLib.get_monotonic_time();
            if (!this._movingMetaWindow.has_focus())
            this._movingMetaWindow.activate(currentTime);

            // Unmaximize
            this._movingMetaWindow.unmaximize(Meta.MaximizeFlags.BOTH);

            // Connect to _sizeChanged
            this._sizeHandler = this._movingMetaWindow.connect('size-changed', function(){
                outerThis._movingMetaWindow.disconnect(outerThis._sizeHandler);
                outerThis._sizeHandler = null;
                const windowSize = outerThis._movingMetaWindow.get_frame_rect();

                // Update window-center
                outerThis._pointerWindowDiffX = -windowSize.width / 2;
                outerThis._pointerWindowDiffY = -windowSize.height / 2;
            });


            const frameRect = this._movingMetaWindow.get_frame_rect();

            // Can center window to pointer, because window->saved_rect is private in mutter
            this._pointerWindowDiffX = -frameRect.width / 3;
            this._pointerWindowDiffY = -frameRect.height / 3;
        } else {
            // Store delta from pointer to window pos
            const frameRect = this._movingMetaWindow.get_frame_rect();
            this._pointerWindowDiffX = frameRect.x - pointerX;
            this._pointerWindowDiffY = frameRect.y - pointerY;
        }
        
        this._thresholdExceeded = false;
        this._moveDeltaX = 0;
        this._moveDeltaY = 0;

        return Clutter.EVENT_STOP;
    }

    _gestureUpdate_win(dx, dy) {

        // Pointer not on top of a window
        if (this._movingMetaWindow == null)
            return Clutter.EVENT_PROPAGATE;

        // Focus window
        const currentTime = GLib.get_monotonic_time();
        if (!this._movingMetaWindow.has_focus())
            this._movingMetaWindow.activate(currentTime);

        // Apply acceleration
        dx *= this._acceleration;
        dy *= this._acceleration;

        // Move and apply acceleration if threshold exeeded
        const [pointerX, pointerY, pointerZ] = global.get_pointer();
        if (!this._thresholdExceeded) {
            this._moveDeltaX += dx;
            this._moveDeltaY += dy;
            if (this._moveDeltaX * this._moveDeltaX + this._moveDeltaY * this._moveDeltaY >= this._thresholdSquare) {
                this._thresholdExceeded = true;
                if (this._summarizeThreshold) {
                    dx = this._moveDeltaX;
                    dy = this._moveDeltaY;
                }
            } else {
                return Clutter.EVENT_STOP;
            }
        }
        this._virtualTouchpad.notify_relative_motion(currentTime, dx, dy);
        this._movingMetaWindow.move_frame(
            true,
            pointerX + this._pointerWindowDiffX,
            pointerY + this._pointerWindowDiffY
        );

        // Handle window snap
        if (!this._movingMetaWindow.can_maximize() || !this._movingMetaWindow.has_focus())
            return Clutter.EVENT_STOP;
        if (pointerX < this._monitorGeometry.x + EDGE_THRESHOLD) {
            // Handle snap to left
            if (this._nextSnapAction != SnapAction.TILE_LEFT) {
                this._nextSnapAction = SnapAction.TILE_LEFT;
                this._previewRect.x = this._monitorGeometry.x;
                this._previewRect.y = this._monitorGeometry.y;
                this._previewRect.height = this._monitorGeometry.height;

                // Handle preview width
                const width = this._windowAtPos(this._monitorGeometry.x + this._monitorGeometry.width - 1, true);
                if (width)
                    this._previewRect.width = width;
                else
                    this._previewRect.width = this._monitorGeometry.width / 2;
                global.window_manager.emit("show-tile-preview", this._movingMetaWindow, this._previewRect, this._monitorIndex);
            }
        } else if (pointerX > this._monitorGeometry.x + this._monitorGeometry.width - EDGE_THRESHOLD) {
            // Handle snap to right
            if (this._nextSnapAction != SnapAction.TILE_RIGHT) {
                this._nextSnapAction = SnapAction.TILE_RIGHT;
                this._previewRect.y = this._monitorGeometry.y;
                this._previewRect.height = this._monitorGeometry.height;

                // Handle preview width
                const width = this._windowAtPos(this._monitorGeometry.x, false);
                if (width)
                    this._previewRect.width = width;
                else
                    this._previewRect.width = this._monitorGeometry.width / 2;

                this._previewRect.x = this._monitorGeometry.x + this._monitorGeometry.width - this._previewRect.width;
                global.window_manager.emit("show-tile-preview", this._movingMetaWindow, this._previewRect, this._monitorIndex);
            }
        } else if (pointerY < this._monitorGeometry.y + 1) {
            // Handle maximize
            if (this._nextSnapAction != SnapAction.MAXIMIZE) {
                this._nextSnapAction = SnapAction.MAXIMIZE;
                global.window_manager.emit("show-tile-preview", this._movingMetaWindow, this._monitorGeometry, this._monitorIndex);
            }
        } else if (this._nextSnapAction != SnapAction.NONE) {
            // Hide tile-preview, if there won't be a snap
            this._nextSnapAction = SnapAction.NONE;
            global.window_manager.emit("hide-tile-preview");
        }

        return Clutter.EVENT_STOP;
    }

    _gestureEnd_win() {

        // Nothing to move around
        if (this._movingMetaWindow == null)
            return Clutter.EVENT_PROPAGATE;

        // Hide tile-preview
        if (this._nextSnapAction != SnapAction.NONE)
            global.window_manager.emit("hide-tile-preview");

        // Do snap
        const currentTime = GLib.get_monotonic_time();
        switch (this._nextSnapAction) {
            case SnapAction.MAXIMIZE:
                this._movingMetaWindow.maximize(Meta.MaximizeFlags.BOTH);
                break;
            case SnapAction.TILE_LEFT:
                // TODO: find way to get keybinding from gSettings and convert to Clutter keyvals
                this._press_combination(currentTime, [Clutter.KEY_Super_L, Clutter.KEY_Left]);
                break;
            case SnapAction.TILE_RIGHT:
                this._press_combination(currentTime, [Clutter.KEY_Super_L, Clutter.KEY_Right]);
                break;
        }

        // Reset
        if (this._sizeHandler != null)
            this._movingMetaWindow.disconnect(this._sizeHandler);

        if (this._unmanagedHandler != null)
            this._movingMetaWindow.disconnect(this._unmanagedHandler);

        if (this._workspaceChangedHandler != null)
            this._movingMetaWindow.disconnect(this._workspaceChangedHandler);

        this._sizeHandler = null;
        this._unmanagedHandler = null;
        this._movingMetaWindow = null;
        this._nextSnapAction = SnapAction.NONE;

        return Clutter.EVENT_STOP;
    }

    // Press key
    _press_combination(currentTime, combination) {
        combination.forEach(key => this._virtualKeyboard.notify_keyval(currentTime, key, Clutter.KeyState.PRESSED));
        combination.reverse().forEach(key => this._virtualKeyboard.notify_keyval(currentTime, key, Clutter.KeyState.RELEASED));
    }

    // Really not the nicest way but it seems as if there is no API avaliable to test if window ist tiled
    _windowAtPos(xLook, left) {
        const metaActor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, xLook, this._monitorGeometry.y).get_parent();
        // There is no other window
        if (metaActor == null || metaActor.get_meta_window == undefined)
            return false;
        const metaWindow = metaActor.get_meta_window();
        const metaWindowRect = metaWindow.get_frame_rect();
        // Other window is not at topmost position
        if (metaWindowRect.y != this._monitorGeometry.y)
            return false;

        if (left) {
            // Other window is not at rightmost position
            if (metaWindowRect.x + metaWindowRect.width != this._monitorGeometry.x + this._monitorGeometry.width)
                return false;
        } else {
            // Other window is not at leftmost position
            if (metaWindowRect.x != this._monitorGeometry.x)
                return false;
        }

        // Only if window ist vertically maximized return width
        if (metaWindowRect.height === this._monitorGeometry.height && metaWindow.get_maximized() === Meta.MaximizeFlags.VERTICAL)
            return this._monitorGeometry.width - metaWindowRect.width;

        return false;
    }

    _cleanup() {
        global.stage.disconnect(this._gestureCallbackID);
        global.window_manager.disconnect(this._windowsManagerSizeChangedCallbackID);
        global.display.disconnect(this._displayGrabOpBeginCallbackID);
        global.display.disconnect(this._displayGrabOpEndCallbackID);
        this._settings.disconnect(this._settingsChangedCallbackID);
    }

};

class SwapGesturesExtension {
  constructor() {}

  enable() {
    this._swipeMods = [
      Main.overview._swipeTracker._touchpadGesture,
      Main.wm._workspaceAnimation._swipeTracker._touchpadGesture,
      Main.overview._overview._controls._workspacesDisplay._swipeTracker
        ._touchpadGesture,
      // Main.overview._overview._controls._appDisplay._swipeTracker._touchpadGesture
    ];

    this._swipeMods.forEach((g) => {
      g._newHandleEvent = (actor, event) => {
        event._get_touchpad_gesture_finger_count =
          event.get_touchpad_gesture_finger_count;
        event.get_touchpad_gesture_finger_count = () => {
          return event._get_touchpad_gesture_finger_count() == 4 ? 3 : 0;
        };
        return g._handleEvent(actor, event);
      };

      global.stage.disconnectObject(g);
      global.stage.connectObject(
        'captured-event::touchpad',
        g._newHandleEvent.bind(g),
        g
      );
    });
  }

  disable() {
    this._swipeMods.forEach((g) => {
      global.stage.disconnectObject(g);
      global.stage.connectObject(
        'captured-event::touchpad',
        g._handleEvent.bind(g),
        g
      );
    });
    this._swipeMods = [];
  }
}

Signals.addSignalMethods(TouchpadGestureAction.prototype);

function enable() {
    swapGesturesHandler = new SwapGesturesExtension();
    swapGesturesHandler.enable();
    gestureHandler = new TouchpadGestureAction(global.stage, global.window_manager, global.display);
}

function disable(){
    gestureHandler._cleanup();
    gestureHandler = null;

    swapGesturesHandler.disable();
    swapGesturesHandler = null;
}
