// Tamas <-> Java bridge. Tamas starts this with `java TamasBridge.java` and sends one JSON request per line.
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.lang.reflect.Array;
import java.lang.reflect.Constructor;
import java.lang.reflect.Executable;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

public class TamasBridge {
    static final String MARK = "@@TAMAS@@ ";
    static final Object NO = new Object();
    static final Map<Long, Object> roots = new HashMap<>();
    static long nextRoot = 1;

    // ---- JSON in
    static String src;
    static int pos;

    static Object parse(String text) {
        src = text;
        pos = 0;
        return value();
    }

    static void ws() {
        while (pos < src.length() && Character.isWhitespace(src.charAt(pos))) pos++;
    }

    static Object value() {
        ws();
        char c = src.charAt(pos);
        if (c == '{') {
            Map<String, Object> m = new LinkedHashMap<>();
            pos++;
            ws();
            while (src.charAt(pos) != '}') {
                ws();
                String k = string();
                ws();
                pos++;
                m.put(k, value());
                ws();
                if (src.charAt(pos) == ',') pos++;
            }
            pos++;
            return m;
        }
        if (c == '[') {
            List<Object> l = new ArrayList<>();
            pos++;
            ws();
            while (src.charAt(pos) != ']') {
                l.add(value());
                ws();
                if (src.charAt(pos) == ',') pos++;
                ws();
            }
            pos++;
            return l;
        }
        if (c == '"') return string();
        if (src.startsWith("true", pos)) { pos += 4; return Boolean.TRUE; }
        if (src.startsWith("false", pos)) { pos += 5; return Boolean.FALSE; }
        if (src.startsWith("null", pos)) { pos += 4; return null; }
        int start = pos;
        while (pos < src.length() && "+-0123456789.eE".indexOf(src.charAt(pos)) >= 0) pos++;
        String num = src.substring(start, pos);
        if (num.contains(".") || num.contains("e") || num.contains("E")) return Double.parseDouble(num);
        try {
            return Long.parseLong(num);
        } catch (NumberFormatException e) {
            return Double.parseDouble(num);
        }
    }

    static String string() {
        StringBuilder sb = new StringBuilder();
        pos++;
        while (src.charAt(pos) != '"') {
            char c = src.charAt(pos++);
            if (c != '\\') { sb.append(c); continue; }
            char e = src.charAt(pos++);
            switch (e) {
                case 'n': sb.append('\n'); break;
                case 't': sb.append('\t'); break;
                case 'r': sb.append('\r'); break;
                case 'b': sb.append('\b'); break;
                case 'f': sb.append('\f'); break;
                case 'u': sb.append((char) Integer.parseInt(src.substring(pos, pos + 4), 16)); pos += 4; break;
                default: sb.append(e);
            }
        }
        pos++;
        return sb.toString();
    }

    // ---- JSON out
    static void write(StringBuilder sb, Object v) {
        if (v == null) { sb.append("null"); return; }
        if (v instanceof Boolean || v instanceof Integer || v instanceof Long || v instanceof Short || v instanceof Byte) {
            sb.append(v);
        } else if (v instanceof Double || v instanceof Float) {
            double d = ((Number) v).doubleValue();
            sb.append(Double.isFinite(d) ? String.valueOf(d) : "null");
        } else if (v instanceof Map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (!first) sb.append(',');
                first = false;
                write(sb, String.valueOf(e.getKey()));
                sb.append(':');
                write(sb, e.getValue());
            }
            sb.append('}');
        } else if (v instanceof Collection) {
            sb.append('[');
            boolean first = true;
            for (Object x : (Collection<?>) v) {
                if (!first) sb.append(',');
                first = false;
                write(sb, x);
            }
            sb.append(']');
        } else if (v.getClass().isArray()) {
            sb.append('[');
            for (int i = 0; i < Array.getLength(v); i++) {
                if (i > 0) sb.append(',');
                write(sb, Array.get(v, i));
            }
            sb.append(']');
        } else {
            sb.append('"');
            for (char c : v.toString().toCharArray()) {
                if (c == '"' || c == '\\') sb.append('\\').append(c);
                else if (c < 32 || c > 126) sb.append(String.format("\\u%04x", (int) c));
                else sb.append(c);
            }
            sb.append('"');
        }
    }

    // ---- values crossing the bridge
    static boolean plain(Object v) {
        if (v == null || v instanceof Boolean || v instanceof String || v instanceof Character) return true;
        if (v instanceof Integer || v instanceof Long || v instanceof Short || v instanceof Byte) return true;
        if (v instanceof Double || v instanceof Float) return Double.isFinite(((Number) v).doubleValue());
        if (v instanceof Map) {
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (!(e.getKey() instanceof String) || !plain(e.getValue())) return false;
            }
            return true;
        }
        if (v instanceof Collection) {
            for (Object x : (Collection<?>) v) if (!plain(x)) return false;
            return true;
        }
        if (v.getClass().isArray()) {
            for (int i = 0; i < Array.getLength(v); i++) if (!plain(Array.get(v, i))) return false;
            return true;
        }
        return false;
    }

    static Map<String, Object> describe(Object v, boolean store) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (plain(v)) {
            out.put("kind", "value");
            out.put("value", v);
        } else {
            out.put("kind", "object");
            if (store) {
                roots.put(nextRoot, v);
                out.put("root", nextRoot++);
                out.put("path", new ArrayList<>());
            }
        }
        return out;
    }

    static Object decode(Object v) {
        if (v instanceof List) {
            List<Object> out = new ArrayList<>();
            for (Object x : (List<?>) v) out.add(decode(x));
            return out;
        }
        if (v instanceof Map) {
            Map<?, ?> m = (Map<?, ?>) v;
            if (m.containsKey("__tamas_ref__")) {
                Map<?, ?> ref = (Map<?, ?>) m.get("__tamas_ref__");
                return resolve(roots.get(ref.get("root")), (List<?>) ref.get("path"), ((List<?>) ref.get("path")).size());
            }
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : m.entrySet()) out.put((String) e.getKey(), decode(e.getValue()));
            return out;
        }
        return v;
    }

    static Object small(Object v) {
        if (v instanceof Long) {
            long l = (Long) v;
            if (l >= Integer.MIN_VALUE && l <= Integer.MAX_VALUE) return (int) l;
        }
        return v;
    }

    /** Convert a Tamas value to parameter type t, or NO. score[0] collects how good the match is. */
    static Object conv(Object v, Class<?> t, int[] score) {
        if (v == null) return t.isPrimitive() ? NO : null;
        if (v instanceof Long) {
            long l = (Long) v;
            boolean fits = l >= Integer.MIN_VALUE && l <= Integer.MAX_VALUE;
            if ((t == int.class || t == Integer.class) && fits) { score[0] += 5; return (int) l; }
            if (t == long.class || t == Long.class) { score[0] += 4; return l; }
            if (t == double.class || t == Double.class) { score[0] += 3; return (double) l; }
            if (t == float.class || t == Float.class) { score[0] += 2; return (float) l; }
            if ((t == short.class || t == Short.class) && l >= Short.MIN_VALUE && l <= Short.MAX_VALUE) { score[0] += 1; return (short) l; }
            if ((t == byte.class || t == Byte.class) && l >= Byte.MIN_VALUE && l <= Byte.MAX_VALUE) { score[0] += 1; return (byte) l; }
            Object boxed = small(v);
            if (t.isInstance(boxed)) { score[0] += 1; return boxed; }
            return NO;
        }
        if (v instanceof Double) {
            if (t == double.class || t == Double.class) { score[0] += 5; return v; }
            if (t == float.class || t == Float.class) { score[0] += 3; return ((Double) v).floatValue(); }
            if (t.isInstance(v)) { score[0] += 1; return v; }
            return NO;
        }
        if (v instanceof Boolean) {
            if (t == boolean.class || t == Boolean.class) { score[0] += 5; return v; }
            if (t.isInstance(v)) { score[0] += 1; return v; }
            return NO;
        }
        if (v instanceof String) {
            String s = (String) v;
            if (t == String.class) { score[0] += 5; return v; }
            if ((t == char.class || t == Character.class) && s.length() == 1) { score[0] += 3; return s.charAt(0); }
            if (t.isInstance(v)) { score[0] += 2; return v; }
            return NO;
        }
        if (v instanceof List) {
            List<?> l = (List<?>) v;
            if (t.isArray()) {
                Object arr = Array.newInstance(t.getComponentType(), l.size());
                for (int i = 0; i < l.size(); i++) {
                    Object x = conv(l.get(i), t.getComponentType(), new int[1]);
                    if (x == NO) return NO;
                    Array.set(arr, i, x);
                }
                score[0] += 4;
                return arr;
            }
            if (t.isAssignableFrom(ArrayList.class)) {
                List<Object> out = new ArrayList<>();
                for (Object x : l) out.add(small(x));
                score[0] += 3;
                return out;
            }
            return NO;
        }
        if (v instanceof Map && !(t.isAssignableFrom(LinkedHashMap.class))) return NO;
        if (t.isInstance(v)) { score[0] += 3; return v; }
        return NO;
    }

    static Object[] fit(Executable ex, List<Object> args, int[] score) {
        Class<?>[] types = ex.getParameterTypes();
        if (types.length == args.size()) {
            Object[] out = new Object[types.length];
            boolean ok = true;
            for (int i = 0; i < types.length && ok; i++) {
                out[i] = conv(args.get(i), types[i], score);
                ok = out[i] != NO;
            }
            if (ok) { score[0] += 1; return out; }
        }
        if (ex.isVarArgs() && args.size() >= types.length - 1) {
            score[0] = 0;
            Object[] out = new Object[types.length];
            for (int i = 0; i < types.length - 1; i++) {
                out[i] = conv(args.get(i), types[i], score);
                if (out[i] == NO) return null;
            }
            out[types.length - 1] = conv(new ArrayList<>(args.subList(types.length - 1, args.size())), types[types.length - 1], score);
            return out[types.length - 1] == NO ? null : out;
        }
        return null;
    }

    static void collect(Class<?> c, Set<Class<?>> seen) {
        if (c == null || !seen.add(c)) return;
        collect(c.getSuperclass(), seen);
        for (Class<?> i : c.getInterfaces()) collect(i, seen);
    }

    static List<Method> methods(Object target, String name) {
        List<Method> out = new ArrayList<>();
        boolean isStatic = target instanceof Class;
        Set<Class<?>> classes = new LinkedHashSet<>();
        if (isStatic) classes.add((Class<?>) target); else collect(target.getClass(), classes);
        for (Class<?> c : classes) {
            if (!Modifier.isPublic(c.getModifiers())) continue;
            for (Method m : c.getMethods()) {
                if (m.getName().equals(name) && Modifier.isStatic(m.getModifiers()) == isStatic) out.add(m);
            }
        }
        return out;
    }

    static Field field(Object target, String name) {
        try {
            Class<?> c = target instanceof Class ? (Class<?>) target : target.getClass();
            Field f = c.getField(name);
            return Modifier.isStatic(f.getModifiers()) == (target instanceof Class) ? f : null;
        } catch (NoSuchFieldException e) {
            return null;
        }
    }

    static Object resolve(Object target, List<?> path, int upTo) {
        for (int i = 0; i < upTo; i++) {
            String step = (String) path.get(i);
            Field f = target == null ? null : field(target, step);
            if (f == null) throw new RuntimeException("there is no field '" + step + "' here");
            try {
                target = f.get(target instanceof Class ? null : target);
            } catch (IllegalAccessException e) {
                throw new RuntimeException("the field '" + step + "' is not accessible");
            }
        }
        return target;
    }

    static Object invoke(Object target, String name, List<Object> args) throws Exception {
        List<Executable> candidates = new ArrayList<>();
        if (name.equals("new") && target instanceof Class) {
            for (Constructor<?> c : ((Class<?>) target).getConstructors()) candidates.add(c);
        } else {
            candidates.addAll(methods(target, name));
        }
        if (candidates.isEmpty()) throw new RuntimeException("there is no method '" + name + "' here");
        List<Object[]> fits = new ArrayList<>();
        List<Executable> order = new ArrayList<>();
        List<Integer> scores = new ArrayList<>();
        for (Executable ex : candidates) {
            int[] score = new int[1];
            Object[] fitted = fit(ex, args, score);
            if (fitted == null) continue;
            int at = 0;
            while (at < scores.size() && scores.get(at) >= score[0]) at++;
            scores.add(at, score[0]);
            order.add(at, ex);
            fits.add(at, fitted);
        }
        for (int i = 0; i < order.size(); i++) {
            try {
                Executable ex = order.get(i);
                if (ex instanceof Constructor) return ((Constructor<?>) ex).newInstance(fits.get(i));
                return ((Method) ex).invoke(target instanceof Class ? null : target, fits.get(i));
            } catch (IllegalAccessException e) {
                // try the next candidate
            }
        }
        throw new RuntimeException("no version of '" + name + "' accepts these " + args.size() + " value(s)");
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> handle(Map<String, Object> req) throws Exception {
        String op = (String) req.get("op");
        if (op.equals("load")) {
            Map<String, Object> out = new LinkedHashMap<>();
            roots.put(nextRoot, Class.forName((String) req.get("name")));
            out.put("kind", "object");
            out.put("root", nextRoot++);
            out.put("path", new ArrayList<>());
            return out;
        }
        List<Object> path = (List<Object>) req.get("path");
        Object target = resolve(roots.get(req.get("root")), path, path.size() - 1);
        String name = (String) path.get(path.size() - 1);
        Map<String, Object> out = new LinkedHashMap<>();
        if (op.equals("get")) {
            Field f = target == null ? null : field(target, name);
            if (f != null) return describe(f.get(target instanceof Class ? null : target), false);
            boolean callable = target != null && (!methods(target, name).isEmpty() || (name.equals("new") && target instanceof Class));
            out.put("kind", callable ? "function" : "missing");
            return out;
        }
        if (target == null) throw new RuntimeException("cannot call '" + name + "' on nothing");
        Object result = invoke(target, name, (List<Object>) decode(req.get("args")));
        if (name.equals("new") && target instanceof Class) {
            roots.put(nextRoot, result);
            out.put("kind", "object");
            out.put("root", nextRoot++);
            out.put("path", new ArrayList<>());
            return out;
        }
        return describe(result, true);
    }

    @SuppressWarnings("unchecked")
    public static void main(String[] argv) throws Exception {
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        PrintStream out = new PrintStream(System.out, true, "UTF-8");
        String line;
        while ((line = in.readLine()) != null) {
            Map<String, Object> reply = new LinkedHashMap<>();
            try {
                reply.put("ok", true);
                reply.putAll(handle((Map<String, Object>) parse(line)));
            } catch (Throwable e) {
                Throwable cause = e instanceof InvocationTargetException && e.getCause() != null ? e.getCause() : e;
                reply.clear();
                reply.put("ok", false);
                String msg = cause.getMessage();
                reply.put("error", cause.getClass().getSimpleName() + (msg == null ? "" : ": " + msg));
            }
            StringBuilder sb = new StringBuilder(MARK);
            write(sb, reply);
            System.out.flush();
            out.println(sb);
        }
    }
}
