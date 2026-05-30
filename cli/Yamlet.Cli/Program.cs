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

        Console.WriteLine($"Yamlet {Version()}");
        Console.WriteLine($"Workspace:   {workspace.RootPath}");
        Console.WriteLine($"Environment: {environment?.Name ?? "(none)"}");
        Console.WriteLine($"Requests:    {totalRequests}");
        Console.WriteLine();

        var executor = RequestExecutor.CreateDefault();
        var runner = new CollectionRunner(executor);
        var report = await runner.RunAsync(
            workspace, environment, new RunOptions { Bail = options.Bail }).ConfigureAwait(false);

        PrintReport(report);
        return report.Success ? 0 : 1;
    }

    // ---- Reporting ---------------------------------------------------------

    private static void PrintReport(RunReport report)
    {
        string? currentCollection = null;
        foreach (var r in report.Requests)
        {
            if (r.Collection != currentCollection)
            {
                currentCollection = r.Collection;
                Console.WriteLine($"# {currentCollection}");
            }

            var status = r.TransportError ? "ERROR" : $"{r.StatusCode} {r.ReasonPhrase}".Trim();
            var label = r.Failed ? "FAIL" : "PASS";
            Console.WriteLine($"{label}  {r.Method,-6} {r.Url} -> {status} ({r.DurationMs}ms)");

            if (r.TransportError && r.ErrorMessage is not null)
            {
                Console.WriteLine($"        {r.ErrorMessage}");
            }

            foreach (var test in r.Tests)
            {
                var marker = test.Passed ? "ok    " : "not ok";
                var suffix = test.Passed || string.IsNullOrEmpty(test.Message) ? string.Empty : $": {test.Message}";
                Console.WriteLine($"  {marker}  {test.Name}{suffix}");
            }
        }

        Console.WriteLine();
        Console.WriteLine(
            $"Summary: {report.Total} requests, {report.PassedCount} passed, {report.FailedCount} failed; " +
            $"{report.TotalAssertions} assertions, {report.FailedAssertions} failed.");
    }

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

        return new RunArguments(Path.GetFullPath(workspace), env, globals, bail);
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
              -h, --help            Show this help.
              -v, --version         Show the CLI version.

            Exit code:
              0 if every request returned 2xx/3xx and every pm.test passed; 1 otherwise.

            Example:
              yamlet run ./my-workspace --env environments/dev.yml
            """);
    }

    private sealed record RunArguments(string WorkspacePath, string? EnvFile, string? GlobalsFile, bool Bail);

    private sealed class CliException(string message) : Exception(message);
}
