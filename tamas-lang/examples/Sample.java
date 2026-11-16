import java.util.ArrayList;
import java.util.List;

// A small Java program used to demonstrate the Java -> Tamas converter.
public class Sample {
    static final int LIMIT = 30;

    static boolean isPrime(int n) {
        if (n < 2) {
            return false;
        }
        for (int d = 2; d * d <= n; d++) {
            if (n % d == 0) {
                return false;
            }
        }
        return true;
    }

    static int sum(int[] values) {
        int total = 0;
        for (int v : values) {
            total += v;
        }
        return total;
    }

    static String grade(int score) {
        return score >= 80 ? "A" : score >= 60 ? "B" : "C";
    }

    public static void main(String[] args) {
        List<Integer> primes = new ArrayList<>();
        for (int i = 0; i < LIMIT; i++) {
            if (isPrime(i)) {
                primes.add(i);
            }
        }
        System.out.println("primes below " + LIMIT + ": " + primes);

        int[] scores = {91, 78, 55, 64};
        int total = sum(scores);
        System.out.println("total " + total + ", whole average " + total / scores.length + ", remainder " + total % scores.length);

        String line = "";
        for (int i = 0; i < scores.length; i++) {
            line += grade(scores[i]);
        }
        System.out.println("grades " + line + " " + line.equals("ACCB") + " " + (-7 / 2) + " " + (-7 % 3));

        int[][] grid = new int[3][4];
        grid[1][2] = Math.max(total, 7) - 280;
        System.out.println(grid[1][2] + grid[0][0] + " cells: " + grid.length * grid[0].length);
    }
}
