using Yamlet.App.Models;

namespace Yamlet.App.Services;

public enum RequestScriptVariableScope
{
    Local,
    Environment,
    Collection,
    Globals,
}

/// <summary>Mutable variable scopes exposed to request scripts during a send.</summary>
public sealed class RequestScriptVariables
{
    private readonly Dictionary<string, string> _local = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<YamletVariable>? _globals;
    private readonly List<YamletVariable>? _environment;
    private readonly List<YamletVariable>? _collection;
    private readonly List<YamletVariable>? _request;
    private readonly Func<IReadOnlySet<RequestScriptVariableScope>, Task>? _persistAsync;
    private readonly HashSet<RequestScriptVariableScope> _dirty = new();

    public RequestScriptVariables(
        VariableContext context,
        List<YamletVariable>? globals = null,
        List<YamletVariable>? environment = null,
        List<YamletVariable>? collection = null,
        List<YamletVariable>? request = null,
        Func<IReadOnlySet<RequestScriptVariableScope>, Task>? persistAsync = null)
    {
        foreach (var pair in context.Values)
        {
            _local[pair.Key] = pair.Value;
        }

        _globals = globals;
        _environment = environment;
        _collection = collection;
        _request = request;
        _persistAsync = persistAsync;
    }

    public static RequestScriptVariables FromContext(VariableContext context) => new(context);

    public VariableContext ToContext()
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        AddLayer(values, _globals);
        AddLayer(values, _environment);
        AddLayer(values, _collection);
        AddLayer(values, _request);
        foreach (var pair in _local)
        {
            values[pair.Key] = pair.Value;
        }
        return VariableContext.FromDictionary(values);
    }

    public string? GetLocal(string key) => _local.TryGetValue(key, out var value) ? value : GetAny(key);
    public string? GetEnvironment(string key) => GetFrom(_environment, key);
    public string? GetCollection(string key) => GetFrom(_collection, key);
    public string? GetGlobals(string key) => GetFrom(_globals, key);

    public void SetLocal(string key, string value)
    {
        if (string.IsNullOrWhiteSpace(key))
        {
            return;
        }
        _local[key] = value ?? string.Empty;
        _dirty.Add(RequestScriptVariableScope.Local);
    }

    public void SetEnvironment(string key, string value) =>
        SetIn(_environment, RequestScriptVariableScope.Environment, key, value);

    public void SetCollection(string key, string value) =>
        SetIn(_collection, RequestScriptVariableScope.Collection, key, value);

    public void SetGlobals(string key, string value) =>
        SetIn(_globals, RequestScriptVariableScope.Globals, key, value);

    public void UnsetLocal(string key)
    {
        if (_local.Remove(key))
        {
            _dirty.Add(RequestScriptVariableScope.Local);
        }
    }

    public void UnsetEnvironment(string key) => UnsetIn(_environment, RequestScriptVariableScope.Environment, key);
    public void UnsetCollection(string key) => UnsetIn(_collection, RequestScriptVariableScope.Collection, key);
    public void UnsetGlobals(string key) => UnsetIn(_globals, RequestScriptVariableScope.Globals, key);

    public async Task PersistAsync()
    {
        if (_persistAsync is not null && _dirty.Count > 0)
        {
            await _persistAsync(_dirty).ConfigureAwait(false);
        }
    }

    private string? GetAny(string key) =>
        GetFrom(_request, key) ??
        GetFrom(_collection, key) ??
        GetFrom(_environment, key) ??
        GetFrom(_globals, key);

    private static void AddLayer(Dictionary<string, string> values, IEnumerable<YamletVariable>? variables)
    {
        if (variables is null)
        {
            return;
        }

        foreach (var variable in variables.Where(v => v.Enabled && !string.IsNullOrEmpty(v.Key)))
        {
            values[variable.Key] = variable.Value;
        }
    }

    private static string? GetFrom(IEnumerable<YamletVariable>? variables, string key) =>
        variables?.FirstOrDefault(v => v.Enabled && string.Equals(v.Key, key, StringComparison.OrdinalIgnoreCase))?.Value;

    private void SetIn(List<YamletVariable>? variables, RequestScriptVariableScope scope, string key, string value)
    {
        if (variables is null)
        {
            SetLocal(key, value);
            return;
        }

        if (string.IsNullOrWhiteSpace(key))
        {
            return;
        }

        var variable = variables.FirstOrDefault(v => string.Equals(v.Key, key, StringComparison.OrdinalIgnoreCase));
        if (variable is null)
        {
            variables.Add(new YamletVariable { Key = key, Value = value ?? string.Empty, Enabled = true });
        }
        else
        {
            variable.Value = value ?? string.Empty;
            variable.Enabled = true;
        }
        _dirty.Add(scope);
    }

    private void UnsetIn(List<YamletVariable>? variables, RequestScriptVariableScope scope, string key)
    {
        if (variables is null)
        {
            UnsetLocal(key);
            return;
        }

        var removed = variables.RemoveAll(v => string.Equals(v.Key, key, StringComparison.OrdinalIgnoreCase));
        if (removed > 0)
        {
            _dirty.Add(scope);
        }
    }
}
