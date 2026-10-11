"""Acceptance GUI session: never saves prefs or files; flips UI scale, records state, then quits."""
import bpy, json, os, sys, time
OUT = os.environ['ACCEPTANCE_GUI_OUT']
bpy.context.preferences.use_preferences_save = False
t0 = time.monotonic()
state = {'events': []}

def log(name, **extra):
    state['events'].append({'t': round(time.monotonic() - t0, 1), 'event': name, **extra})
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=False, indent=1)

def snapshot():
    wm = bpy.context.window_manager
    areas = [a.type for w in wm.windows for a in w.screen.areas]
    mods = sorted(m for m in sys.modules if m.startswith(('jabberwock', 'snark', 'mixar.config.local_mode', 'mixar.modules.space_agent', 'mixar.modules.connector')))
    from mixar.config import local_mode
    return {'areas': areas, 'ui_scale': bpy.context.preferences.view.ui_scale, 'pixel_size': bpy.context.preferences.system.pixel_size,
            'dpi': bpy.context.preferences.system.dpi, 'local_mode': local_mode.is_local_mode(), 'modules': mods,
            'bridge_running': bool(bpy.app.driver_namespace.get('JABBERWOCK_BLENDER_BRIDGE_FULL') or any('bridge' in k.lower() for k in bpy.app.driver_namespace.keys())),
            'driver_keys': sorted(k for k in bpy.app.driver_namespace.keys() if isinstance(k, str))[:40],
            'dirty': bpy.data.is_dirty}

def phase1():
    log('scale1', **snapshot())
    return None

def redraw():
    for w in bpy.context.window_manager.windows:
        for a in w.screen.areas:
            a.tag_redraw()
    return 0.5

def phase2():
    bpy.context.preferences.view.ui_scale = 2.0
    log('scale2_set')
    return None

bpy.app.timers.register(redraw, first_interval=1, persistent=True)

def phase3():
    log('scale2', **snapshot())
    return None

def phase4():
    log('quit', dirty=bpy.data.is_dirty)
    if not bpy.data.is_dirty:
        bpy.ops.wm.quit_blender()
    return None

bpy.app.timers.register(phase1, first_interval=25, persistent=True)
bpy.app.timers.register(phase2, first_interval=40, persistent=True)
bpy.app.timers.register(phase3, first_interval=48, persistent=True)
bpy.app.timers.register(phase4, first_interval=70, persistent=True)
log('started')
