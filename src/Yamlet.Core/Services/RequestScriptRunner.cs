using Jint;
using Yamlet.App.Models;

namespace Yamlet.App.Services;

/// <summary>The outcome of a single <c>pm.test(name, fn)</c> assertion.</summary>
public sealed record ScriptTestResult(string Name, bool Passed, string? Message);

/// <summary>
/// Executes per-request JavaScript with a small Yamlet-compatible <c>pm</c> surface.
/// Scripts run in a short-lived engine for each phase.
/// </summary>
public sealed class RequestScriptRunner
{
    private static readonly TimeSpan ScriptTimeout = TimeSpan.FromSeconds(5);

    public void RunPreRequest(
        YamletRequest request,
        RequestScriptVariables variables,
        string? collectionScript = null,
        IList<ScriptTestResult>? tests = null)
    {
        // Collection-scope script runs first, then the request's own.
        RunCollectionScript(request, variables, response: null, collectionScript, tests);

        if (!string.IsNullOrWhiteSpace(request.PreRequestScript))
        {
            CreateEngine(request, variables, response: null, tests).Execute(request.PreRequestScript);
        }
    }

    public void RunPostResponse(
        YamletRequest request,
        YamletResponse response,
        RequestScriptVariables variables,
        string? collectionScript = null,
        IList<ScriptTestResult>? tests = null)
    {
        if (!string.IsNullOrWhiteSpace(request.PostResponseScript))
        {
            CreateEngine(request, variables, response, tests).Execute(request.PostResponseScript);
        }

        RunCollectionScript(request, variables, response, collectionScript, tests);
    }

    /// <summary>
    /// Runs a collection-scope script in its own engine. Errors are swallowed so a failing
    /// collection script (commonly a test assertion) can't turn a sent request into a
    /// failure — collection scripts apply to every request and shouldn't abort the send.
    /// Captured <c>pm.test</c> results (when <paramref name="tests"/> is supplied) are still
    /// recorded before the failure is swallowed.
    /// </summary>
    private void RunCollectionScript(
        YamletRequest request,
        RequestScriptVariables variables,
        YamletResponse? response,
        string? script,
        IList<ScriptTestResult>? tests)
    {
        if (string.IsNullOrWhiteSpace(script))
        {
            return;
        }

        try
        {
            CreateEngine(request, variables, response, tests).Execute(script);
        }
        catch
        {
            // Ignore collection-script failures (e.g. test assertions).
        }
    }

    private static Engine CreateEngine(
        YamletRequest request,
        RequestScriptVariables variables,
        YamletResponse? response,
        IList<ScriptTestResult>? tests)
    {
        var engine = new Engine(options => options.TimeoutInterval(ScriptTimeout));

        // When a sink is supplied (CLI/runner), pm.test records each assertion and continues;
        // otherwise a failed assertion throws and aborts, preserving the app's existing behavior.
        var collectTests = tests is not null;
        engine.SetValue("__collectTests", collectTests);
        engine.SetValue("__recordTest", (Action<string, bool, string>)((name, ok, message) =>
            tests?.Add(new ScriptTestResult(name, ok, string.IsNullOrEmpty(message) ? null : message))));

        // Resolves {{placeholders}} (including dynamic $variables) against the live scopes
        // at call time, so pm.variables.replaceIn('{{$randomFirstName}}') works in scripts.
        var resolver = new VariableResolver();
        engine.SetValue("__replaceIn", (Func<string, string>)(template =>
            resolver.Resolve(template, variables.ToContext())));

        engine.SetValue("__getVariable", (Func<string, string?>)(variables.GetLocal));
        engine.SetValue("__setVariable", (Action<string, string>)(variables.SetLocal));
        engine.SetValue("__unsetVariable", (Action<string>)(variables.UnsetLocal));
        engine.SetValue("__getEnvironmentVariable", (Func<string, string?>)(variables.GetEnvironment));
        engine.SetValue("__setEnvironmentVariable", (Action<string, string>)(variables.SetEnvironment));
        engine.SetValue("__unsetEnvironmentVariable", (Action<string>)(variables.UnsetEnvironment));
        engine.SetValue("__getCollectionVariable", (Func<string, string?>)(variables.GetCollection));
        engine.SetValue("__setCollectionVariable", (Action<string, string>)(variables.SetCollection));
        engine.SetValue("__unsetCollectionVariable", (Action<string>)(variables.UnsetCollection));
        engine.SetValue("__getGlobalVariable", (Func<string, string?>)(variables.GetGlobals));
        engine.SetValue("__setGlobalVariable", (Action<string, string>)(variables.SetGlobals));
        engine.SetValue("__unsetGlobalVariable", (Action<string>)(variables.UnsetGlobals));

        engine.SetValue("__getUrl", (Func<string>)(() => request.Url));
        engine.SetValue("__setUrl", (Action<string>)(value => request.Url = value ?? string.Empty));
        engine.SetValue("__getMethod", (Func<string>)(() => request.Method));
        engine.SetValue("__setMethod", (Action<string>)(value =>
        {
            if (!string.IsNullOrWhiteSpace(value))
            {
                request.Method = value.ToUpperInvariant();
            }
        }));
        engine.SetValue("__getBodyRaw", (Func<string>)(() => request.Body.Raw));
        engine.SetValue("__setBodyRaw", (Action<string>)(value => request.Body.Raw = value ?? string.Empty));
        engine.SetValue("__getHeader", (Func<string, string?>)(name =>
            request.Headers.FirstOrDefault(h =>
                h.Enabled && string.Equals(h.Key, name, StringComparison.OrdinalIgnoreCase))?.Value));
        engine.SetValue("__setHeader", (Action<string, string>)((name, value) =>
        {
            if (string.IsNullOrWhiteSpace(name))
            {
                return;
            }

            var header = request.Headers.FirstOrDefault(h =>
                string.Equals(h.Key, name, StringComparison.OrdinalIgnoreCase));
            if (header is null)
            {
                request.Headers.Add(new YamletHeader { Key = name, Value = value ?? string.Empty, Enabled = true });
            }
            else
            {
                header.Value = value ?? string.Empty;
                header.Enabled = true;
            }
        }));
        engine.SetValue("__removeHeader", (Action<string>)(name =>
            request.Headers.RemoveAll(h => string.Equals(h.Key, name, StringComparison.OrdinalIgnoreCase))));

        engine.SetValue("__responseCode", (Func<int>)(() => response?.StatusCode ?? 0));
        engine.SetValue("__responseStatus", (Func<string>)(() => response?.ReasonPhrase ?? string.Empty));
        engine.SetValue("__responseBody", (Func<string>)(() => response?.Body ?? string.Empty));
        engine.SetValue("__responseHeader", (Func<string, string?>)(name =>
            response?.Headers.FirstOrDefault(h =>
                string.Equals(h.Key, name, StringComparison.OrdinalIgnoreCase))?.Value));

        return engine.Execute(BootstrapScript);
    }

    private const string BootstrapScript = """
const __toText = value => value === undefined || value === null ? '' : String(value);
const console = {
  log: (...values) => {},
  info: (...values) => {},
  warn: (...values) => {},
  error: (...values) => {},
  debug: (...values) => {},
  trace: (...values) => {},
  clear: () => {}
};
const __variables = {
  get: key => __getVariable(String(key)),
  set: (key, value) => __setVariable(String(key), __toText(value)),
  unset: key => __unsetVariable(String(key)),
  has: key => __getVariable(String(key)) !== null,
  replaceIn: template => __replaceIn(__toText(template))
};
const __environmentVariables = {
  get: key => __getEnvironmentVariable(String(key)),
  set: (key, value) => __setEnvironmentVariable(String(key), __toText(value)),
  unset: key => __unsetEnvironmentVariable(String(key)),
  has: key => __getEnvironmentVariable(String(key)) !== null
};
const __collectionVariables = {
  get: key => __getCollectionVariable(String(key)),
  set: (key, value) => __setCollectionVariable(String(key), __toText(value)),
  unset: key => __unsetCollectionVariable(String(key)),
  has: key => __getCollectionVariable(String(key)) !== null
};
const __globalVariables = {
  get: key => __getGlobalVariable(String(key)),
  set: (key, value) => __setGlobalVariable(String(key), __toText(value)),
  unset: key => __unsetGlobalVariable(String(key)),
  has: key => __getGlobalVariable(String(key)) !== null
};
const pm = {
  replaceIn: template => __replaceIn(__toText(template)),
  variables: __variables,
  environment: __environmentVariables,
  collectionVariables: __collectionVariables,
  globals: __globalVariables,
  request: {
    get url() { return __getUrl(); },
    set url(value) { __setUrl(__toText(value)); },
    get method() { return __getMethod(); },
    set method(value) { __setMethod(__toText(value)); },
    headers: {
      get: name => __getHeader(String(name)),
      has: name => __getHeader(String(name)) !== null,
      add: header => __setHeader(String(header.key || header.name || ''), __toText(header.value)),
      upsert: header => __setHeader(String(header.key || header.name || ''), __toText(header.value)),
      remove: name => __removeHeader(String(name))
    },
    body: {
      get raw() { return __getBodyRaw(); },
      set raw(value) { __setBodyRaw(__toText(value)); }
    }
  },
  response: {
    get code() { return __responseCode(); },
    get status() { return __responseStatus(); },
    text: () => __responseBody(),
    json: () => JSON.parse(__responseBody() || 'null'),
    headers: {
      get: name => __responseHeader(String(name)),
      has: name => __responseHeader(String(name)) !== null
    }
  },
  test: (name, fn) => {
    try { fn(); __recordTest(String(name), true, ''); }
    catch (e) {
      __recordTest(String(name), false, String((e && e.message) || e));
      if (!__collectTests) throw e;
    }
  },
  expect: value => {
    const assert = (ok, message) => { if (!ok) throw new Error(message); };
    const equal = expected => assert(value === expected, `Expected ${value} to equal ${expected}`);
    const eql = expected => assert(JSON.stringify(value) === JSON.stringify(expected), `Expected ${value} to eql ${expected}`);
    const within = (a, b) => assert(value >= a && value <= b, `Expected ${value} to be within ${a} and ${b}`);
    const above = n => assert(value > n, `Expected ${value} to be above ${n}`);
    const below = n => assert(value < n, `Expected ${value} to be below ${n}`);
    const include = sub => assert(__toText(value).indexOf(__toText(sub)) >= 0, `Expected ${value} to include ${sub}`);
    const oneOf = list => assert(Array.isArray(list) && list.indexOf(value) >= 0, `Expected ${value} to be one of ${list}`);
    const noop = () => api;
    const api = { equal, eql, within, above, below, include, oneOf, a: noop, an: noop };
    api.be = { equal, eql, within, above, below, a: noop, an: noop, ok: () => assert(!!value, `Expected ${value} to be truthy`) };
    api.to = api;
    api.have = { property: () => api };
    return { to: api, that: api };
  }
};
""";
}
