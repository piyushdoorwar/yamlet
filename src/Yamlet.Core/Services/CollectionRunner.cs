using Yamlet.App.Models;

namespace Yamlet.App.Services;

/// <summary>The outcome of running a single request: status, timing, transport state and tests.</summary>
public sealed record RequestRunResult(
    string Collection,
    string Name,
    string Method,
    string Url,
    int StatusCode,
    string ReasonPhrase,
    bool TransportError,
    string? ErrorMessage,
    long DurationMs,
    IReadOnlyList<ScriptTestResult> Tests)
{
    /// <summary>
    /// A request fails the run on a transport error, a non-2xx/3xx status, or any failed
    /// <c>pm.test</c> assertion.
    /// </summary>
    public bool Failed =>
        TransportError || StatusCode is < 200 or > 399 || Tests.Any(t => !t.Passed);
}

/// <summary>Aggregated results of a workspace run.</summary>
public sealed record RunReport(IReadOnlyList<RequestRunResult> Requests)
{
    public int Total => Requests.Count;
    public int FailedCount => Requests.Count(r => r.Failed);
    public int PassedCount => Total - FailedCount;
    public int TotalAssertions => Requests.Sum(r => r.Tests.Count);
    public int FailedAssertions => Requests.Sum(r => r.Tests.Count(t => !t.Passed));
    public bool Success => FailedCount == 0;
}

/// <summary>Options controlling a run.</summary>
public sealed class RunOptions
{
    /// <summary>Stop after the first failing request.</summary>
    public bool Bail { get; init; }
}

/// <summary>
/// Headless run engine: executes every request in a workspace's collections (in tree order)
/// against an optional environment, capturing per-request status and <c>pm.test</c> results.
/// UI-free so it can be driven by the CLI or covered by tests.
/// </summary>
public sealed class CollectionRunner
{
    private readonly RequestExecutor _executor;

    public CollectionRunner(RequestExecutor executor) => _executor = executor;

    public async Task<RunReport> RunAsync(
        YamletWorkspace workspace,
        YamletEnvironment? environment,
        RunOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        options ??= new RunOptions();
        var results = new List<RequestRunResult>();

        foreach (var collection in workspace.Collections.OrderBy(c => c.Order))
        {
            var collectionAuth = collection.Auth.Type != YamletAuthType.None ? collection.Auth : null;

            foreach (var request in Flatten(collection))
            {
                cancellationToken.ThrowIfCancellationRequested();

                var tests = new List<ScriptTestResult>();
                var context = VariableContext.Create(
                    workspace.Globals, environment?.Variables, collection.Variables, request.Variables);

                // Live lists so a request's pm.environment.set / collectionVariables.set is
                // visible to later requests in the same run (chaining), without writing to disk.
                var scriptVariables = new RequestScriptVariables(
                    context,
                    globals: workspace.Globals,
                    environment: environment?.Variables,
                    collection: collection.Variables,
                    request: request.Variables);

                var response = await _executor.ExecuteAsync(
                    request,
                    context,
                    collectionAuth,
                    scriptVariables,
                    cancellationToken,
                    collection.PreRequestScript,
                    collection.PostResponseScript,
                    tests).ConfigureAwait(false);

                results.Add(new RequestRunResult(
                    collection.Name,
                    request.Name,
                    request.Method,
                    string.IsNullOrEmpty(response.ResolvedUrl) ? request.Url : response.ResolvedUrl,
                    response.StatusCode,
                    response.ReasonPhrase,
                    response.IsError,
                    response.ErrorMessage,
                    response.DurationMs,
                    tests));

                if (options.Bail && results[^1].Failed)
                {
                    return new RunReport(results);
                }
            }
        }

        return new RunReport(results);
    }

    /// <summary>Flattens a collection depth-first, sub-folders before requests (sidebar order).</summary>
    private static IEnumerable<YamletRequest> Flatten(YamletCollection collection) =>
        Walk(collection.Folders, collection.Requests);

    private static IEnumerable<YamletRequest> Walk(
        IEnumerable<YamletFolder> folders,
        IEnumerable<YamletRequest> requests)
    {
        foreach (var folder in folders)
        {
            foreach (var request in Walk(folder.Folders, folder.Requests))
            {
                yield return request;
            }
        }

        foreach (var request in requests)
        {
            yield return request;
        }
    }
}
