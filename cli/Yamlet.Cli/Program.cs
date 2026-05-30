using System.Diagnostics;
using System.Text;
using Yamlet.App.Models;
using Yamlet.App.Services;

namespace Yamlet.Cli;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        if (args.Length == 0 || IsHelp(args[0]))
        {
            PrintUsage();
            return args.Length == 0 ? 1 : 0;
        }

        if (args[0] is "--version" or "-v")
        {
            Console.WriteLine(Version());
            return 0;
        }

        if (args[0] != "run")
        {
            Console.Error.WriteLine($"Unknown command '{args[0]}'.");
            PrintUsage();
            return 1;
        }

        try
        {
            return await RunAsync(args[1..]).ConfigureAwait(false);
        }
        catch (CliException ex)
        {
            Console.Error.WriteLine($"error: {ex.Message}");
            return 1;
        }
    }

    private static async Task<int> RunAsync(string[] args)
    {
        var options = ParseRunArgs(args);

        var yaml = new YamlSerializationService();
        var requestFiles = new RequestFileService(yaml);
        var collections = new CollectionService(yaml, requestFiles);
        var workspaces = new WorkspaceService(yaml, collections);

        if (!Directory.Exists(options.WorkspacePath))
        {
            throw new CliException($"Workspace path not found: {options.WorkspacePath}");
        }

        var workspace = await workspaces.OpenWorkspaceAsync(options.WorkspacePath).ConfigureAwait(false);

        if (options.GlobalsFile is not null)
        {
            workspace.Globals = LoadGlobals(yaml, options.GlobalsFile);
        }

        var environment = ResolveEnvironment(yaml, workspace, options.EnvFile);

        var totalRequests = workspace.Collections.Sum(c => CountRequests(c));
        if (totalRequests == 0)
        {
            Console.Error.WriteLine("No requests found in the workspace.");
            return 1;
        }

        var useColor = !options.NoColor && Environment.GetEnvironmentVariable("NO_COLOR") is null;

        Console.WriteLine(Color($"Yamlet {Version()}", Bold, useColor));
        Console.WriteLine($"{Color("Workspace:  ", Dim, useColor)} {workspace.RootPath}");
        Console.WriteLine($"{Color("Environment:", Dim, useColor)} {environment?.Name ?? "(none)"}");
        Console.WriteLine($"{Color("Requests:   ", Dim, useColor)} {totalRequests}");
        Console.WriteLine();

        var executor = RequestExecutor.CreateDefault();
        var runner = new CollectionRunner(executor);

        var stopwatch = Stopwatch.StartNew();
        var report = await runner.RunAsync(
            workspace, environment, new RunOptions { Bail = options.Bail }).ConfigureAwait(false);
        stopwatch.Stop();

        PrintReport(report, stopwatch.ElapsedMilliseconds, useColor);
        return report.Success ? 0 : 1;
    }

    // ---- Reporting ---------------------------------------------------------

    private static void PrintReport(RunReport report, long totalMs, bool useColor)
    {
        var multiCollection = report.Requests.Select(r => r.Collection).Distinct().Count() > 1;

        var headers = multiCollection
            ? new[] { "Result", "Collection", "Method", "URL", "Status", "Time", "Tests" }
            : new[] { "Result", "Method", "URL", "Status", "Time", "Tests" };
        var aligns = multiCollection
            ? new[] { Align.Left, Align.Left, Align.Left, Align.Left, Align.Left, Align.Right, Align.Right }
            : new[] { Align.Left, Align.Left, Align.Left, Align.Left, Align.Right, Align.Right };

        var rows = new List<Cell[]>();
        foreach (var r in report.Requests)
        {
            var passed = r.Tests.Count(t => t.Passed);
            var total = r.Tests.Count;
            var result = r.Failed ? new Cell("FAIL", Red) : new Cell("PASS", Green);
            var status = new Cell(
                r.TransportError ? "ERROR" : $"{r.StatusCode} {r.ReasonPhrase}".Trim(),
                r.Failed ? Red : Green);
            var tests = new Cell(
                total == 0 ? "-" : $"{passed}/{total}",
                total == 0 ? null : passed == total ? Green : Red);
            var time = new Cell($"{r.DurationMs} ms");
            var method = new Cell(r.Method, Cyan);
            var url = new Cell(r.Url);

            rows.Add(multiCollection
                ? new[] { result, new Cell(r.Collection), method, url, status, time, tests }
                : new[] { result, method, url, status, time, tests });
        }

        PrintTable(headers, aligns, rows, useColor);

        var failed = report.Requests.Where(r => r.Failed).ToList();
        if (failed.Count > 0)
        {
            Console.WriteLine();
            Console.WriteLine(Color("Failures:", Red, useColor, bold: true));
            foreach (var r in failed)
            {
                var failedTests = r.Tests.Where(t => !t.Passed).ToList();
                foreach (var t in failedTests)
                {
                    var msg = string.IsNullOrEmpty(t.Message) ? string.Empty : $": {t.Message}";
                    Console.WriteLine("  " + Color($"{r.Name} > {t.Name}{msg}", Red, useColor));
                }
                if (failedTests.Count == 0)
                {
                    var reason = r.TransportError
                        ? r.ErrorMessage ?? "transport error"
                        : $"HTTP {r.StatusCode} {r.ReasonPhrase}".Trim();
                    Console.WriteLine("  " + Color($"{r.Name} ({r.Method} {r.Url}): {reason}", Red, useColor));
                }
            }
        }

        Console.WriteLine();
        var reqSummary =
            $"{report.Total} requests, " +
            Color($"{report.PassedCount} passed", report.PassedCount > 0 ? Green : null, useColor) + ", " +
            Color($"{report.FailedCount} failed", report.FailedCount > 0 ? Red : null, useColor);
        var assertSummary =
            $"{report.TotalAssertions} assertions, " +
            Color($"{report.FailedAssertions} failed", report.FailedAssertions > 0 ? Red : null, useColor);
        Console.WriteLine($"Summary: {reqSummary}; {assertSummary}; {FormatMs(totalMs)} total.");
        Console.WriteLine(report.Success
            ? Color("RESULT: PASS", Green, useColor, bold: true)
            : Color("RESULT: FAIL", Red, useColor, bold: true));
    }

    // ---- Table + color helpers --------------------------------------------

    private enum Align { Left, Right }

    private sealed record Cell(string Text, string? Color = null);

    // ANSI SGR codes.
    private const string Green = "32";
    private const string Red = "31";
    private const string Cyan = "36";
    private const string Dim = "2";
    private const string Bold = "1";

    private static void PrintTable(string[] headers, Align[] aligns, List<Cell[]> rows, bool useColor)
    {
        var widths = new int[headers.Length];
        for (var c = 0; c < headers.Length; c++)
        {
            widths[c] = headers[c].Length;
        }
        foreach (var row in rows)
        {
            for (var c = 0; c < row.Length; c++)
            {
                widths[c] = Math.Max(widths[c], row[c].Text.Length);
            }
        }

        string Rule(char left, char mid, char right) =>
            left + string.Join(mid, widths.Select(w => new string('─', w + 2))) + right;

        Console.WriteLine(Rule('┌', '┬', '┐'));
        PrintRow(headers.Select(h => new Cell(h)).ToArray(), widths, aligns, useColor, bold: true);
        Console.WriteLine(Rule('├', '┼', '┤'));
        foreach (var row in rows)
        {
            PrintRow(row, widths, aligns, useColor);
        }
        Console.WriteLine(Rule('└', '┴', '┘'));
    }

    private static void PrintRow(Cell[] cells, int[] widths, Align[] aligns, bool useColor, bool bold = false)
    {
        var sb = new StringBuilder("│");
        for (var c = 0; c < cells.Length; c++)
        {
            var text = aligns[c] == Align.Right
                ? cells[c].Text.PadLeft(widths[c])
                : cells[c].Text.PadRight(widths[c]);
            sb.Append(' ').Append(Color(text, cells[c].Color, useColor, bold)).Append(' ').Append('│');
        }
        Console.WriteLine(sb.ToString());
    }

    private static string Color(string text, string? code, bool useColor, bool bold = false)
    {
        if (!useColor)
        {
            return text;
        }
        var codes = new List<string>();
        if (bold)
        {
            codes.Add(Bold);
        }
        if (!string.IsNullOrEmpty(code) && code != Bold)
        {
            codes.Add(code);
        }
        else if (code == Bold && !bold)
        {
            codes.Add(Bold);
        }
        return codes.Count == 0 ? text : $"[{string.Join(';', codes)}m{text}[0m";
    }

    private static string FormatMs(long ms) => ms >= 1000 ? $"{ms / 1000.0:0.00} s" : $"{ms} ms";

    // ---- Loading helpers ---------------------------------------------------

    private static YamletEnvironment? ResolveEnvironment(
        YamlSerializationService yaml, YamletWorkspace workspace, string? envArg)
    {
        if (string.IsNullOrWhiteSpace(envArg))
        {
            return null;
        }

        var fullPath = Path.GetFullPath(envArg);
        if (File.Exists(fullPath))
        {
            var dto = yaml.Deserialize<EnvironmentDto>(File.ReadAllText(fullPath));
            var env = dto.ToDomain(fullPath);
            if (string.IsNullOrWhiteSpace(env.Name))
            {
                env.Name = Path.GetFileNameWithoutExtension(fullPath);
            }
            return env;
        }

        // Not a file path — match a loaded environment by name (e.g. --env dev).
        var name = Path.GetFileNameWithoutExtension(envArg);
        var match = workspace.Environments.FirstOrDefault(e =>
            string.Equals(e.Name, envArg, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(e.Name, name, StringComparison.OrdinalIgnoreCase));

        return match ?? throw new CliException(
            $"Environment not found (no file at '{fullPath}' and no environment named '{envArg}').");
    }

    private static List<YamletVariable> LoadGlobals(YamlSerializationService yaml, string globalsFile)
    {
        var fullPath = Path.GetFullPath(globalsFile);
        if (!File.Exists(fullPath))
        {
            throw new CliException($"Globals file not found: {fullPath}");
        }

        return yaml.Deserialize<GlobalsDto>(File.ReadAllText(fullPath)).ToDomain();
    }

    private static int CountRequests(YamletCollection collection)
    {
        int Count(IEnumerable<YamletFolder> folders, IEnumerable<YamletRequest> requests) =>
            requests.Count() + folders.Sum(f => Count(f.Folders, f.Requests));
        return Count(collection.Folders, collection.Requests);
    }

    // ---- Argument parsing --------------------------------------------------

    private static RunArguments ParseRunArgs(string[] args)
    {
        string? workspace = null;
        string? env = null;
        string? globals = null;
        var bail = false;
        var noColor = false;

        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--env" or "-e":
                    env = NextValue(args, ref i, "--env");
                    break;
                case "--globals" or "-g":
                    globals = NextValue(args, ref i, "--globals");
                    break;
                case "--bail":
                    bail = true;
                    break;
                case "--no-color":
                    noColor = true;
                    break;
                default:
                    if (args[i].StartsWith('-'))
                    {
                        throw new CliException($"Unknown option '{args[i]}'.");
                    }
                    if (workspace is not null)
                    {
                        throw new CliException($"Unexpected argument '{args[i]}'.");
                    }
                    workspace = args[i];
                    break;
            }
        }

        if (workspace is null)
        {
            throw new CliException("Missing <workspace> path. Usage: yamlet run <workspace> [--env <file>]");
        }

        return new RunArguments(Path.GetFullPath(workspace), env, globals, bail, noColor);
    }

    private static string NextValue(string[] args, ref int i, string option)
    {
        if (i + 1 >= args.Length)
        {
            throw new CliException($"Option '{option}' requires a value.");
        }
        return args[++i];
    }

    private static bool IsHelp(string arg) => arg is "--help" or "-h" or "help";

    private static string Version() =>
        typeof(Program).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

    private static void PrintUsage()
    {
        Console.WriteLine("""
            Yamlet CLI — run Yamlet API collections headlessly.

            Usage:
              yamlet run <workspace> [options]

            Arguments:
              <workspace>        Path to a Yamlet workspace (a folder containing collections/ and
                                 environments/, or its parent — same as opening it in the app).

            Options:
              -e, --env <file>      Environment YAML to apply (file path, or a loaded environment
                                    name). Omit to run with globals only.
              -g, --globals <file>  Override the workspace globals with this YAML file.
                  --bail            Stop after the first failing request.
                  --no-color        Disable ANSI colors (also honors the NO_COLOR env var).
              -h, --help            Show this help.
              -v, --version         Show the CLI version.

            Exit code:
              0 if every request returned 2xx/3xx and every pm.test passed; 1 otherwise.

            Example:
              yamlet run ./my-workspace --env environments/dev.yml
            """);
    }

    private sealed record RunArguments(
        string WorkspacePath, string? EnvFile, string? GlobalsFile, bool Bail, bool NoColor);

    private sealed class CliException(string message) : Exception(message);
}
