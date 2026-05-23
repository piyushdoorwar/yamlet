using Jint;
using Yamlet.App.Models;

namespace Yamlet.App.Services;

/// <summary>
/// Executes per-request JavaScript with a small Yamlet-compatible <c>pm</c> surface.
/// Scripts run in a short-lived engine for each phase.
/// </summary>
public sealed class RequestScriptRunner
{
    private static readonly TimeSpan ScriptTimeout = TimeSpan.FromSeconds(5);

    public void RunPreRequest(YamletRequest request, RequestScriptVariables variables)
    {
        if (string.IsNullOrWhiteSpace(request.PreRequestScript))
        {
            return;
        }

        CreateEngine(request, variables, response: null)
            .Execute(request.PreRequestScript);
    }

    public void RunPostResponse(
        YamletRequest request,
        YamletResponse response,
        RequestScriptVariables variables)
    {
        if (string.IsNullOrWhiteSpace(request.PostResponseScript))
        {
            return;
        }

        CreateEngine(request, variables, response)
            .Execute(request.PostResponseScript);
    }

    private static Engine CreateEngine(
        YamletRequest request,
        RequestScriptVariables variables,
        YamletResponse? response)
    {
        var engine = new Engine(options => options.TimeoutInterval(ScriptTimeout));

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
  has: key => __getVariable(String(key)) !== null
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
  test: (name, fn) => fn(),
  expect: value => ({
    to: {
      equal: expected => {
        if (value !== expected) {
          throw new Error(`Expected ${value} to equal ${expected}`);
        }
      }
    }
  })
};
""";
}
