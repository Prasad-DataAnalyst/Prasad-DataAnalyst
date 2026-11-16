import java.util.*;

public class Tricky {
    static double rate = 0.5;
    static int[] memo = new int[50];
    static List<String> log = new ArrayList<>();

    static int fib(int n) {
        if (n < 2) return n;
        if (memo[n] != 0) return memo[n];
        memo[n] = fib(n - 1) + fib(n - 2);
        return memo[n];
    }

    static double average(List<Integer> xs) {
        int total = 0;
        for (int x : xs) total += x;
        return (double) total / xs.size();
    }

    static boolean isPalindrome(String s) {
        String r = "";
        String[] parts = {"l", "e", "v", "e", "l"};
        for (int i = parts.length - 1; i >= 0; i--) r += parts[i];
        return r.equals(s) && !s.isEmpty();
    }

    static void note(String msg) { log.add(msg.toUpperCase()); }

    static long power(long base, int exp) {
        long result = 1;
        while (exp > 0) {
            if (exp % 2 == 1) result *= base;
            base *= base;
            exp /= 2;
        }
        return result;
    }

    public static void main(String[] args) {
        System.out.println(fib(40) + " " + power(3, 13) + " " + isPalindrome("level"));
        List<Integer> xs = new ArrayList<>();
        for (int i = 1; i <= 6; i++) { if (i == 4) continue; xs.add(i * i); }
        xs.set(0, 100);
        System.out.println(xs + " size " + xs.size() + " avg>20 " + (average(xs) > 20) + " has25 " + xs.contains(25));
        int a = 17, b = 5;
        double half = a / 2 * rate;
        System.out.println(a / b + " " + a % b + " " + (a / b * b + a % b == a) + " " + (half > 3.9 && half < 4.1) + " " + (int) 9.99 + " " + (int) -9.99);
        note("start"); note("done");
        String joined = "";
        for (String m : log) { joined = joined + m + ";"; }
        System.out.println(joined + joined.length() + " " + Math.abs(-4) + " " + Math.min(a, b) + " " + (Math.sqrt(16.0) == 4.0));
        int[][] t = new int[3][3];
        int k = 0;
        for (int r = 0; r < 3; r++) for (int c = 0; c < 3; c++) { t[r][c] = k; k++; }
        int diag = 0;
        int i = 0;
        while (i < t.length) { diag += t[i][i]; i += 1; }
        boolean big = diag > 10 ? true : false;
        System.out.println(diag + " " + big + " " + t[2][1] + " " + Integer.MAX_VALUE + " " + (1 + 2 + "x" + 1 + 2));
        final var label = xs.isEmpty() ? "none" : "some";
        System.out.println(label);
    }
}
