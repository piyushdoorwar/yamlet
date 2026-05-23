using Yamlet.App.Models;
using Yamlet.App.Services;

namespace Yamlet.Tests;

public class VariableResolverTests
{
    private readonly VariableResolver _resolver = new();

    private static List<YamletVariable> Vars(params (string Key, string Value)[] pairs) =>
        pairs.Select(p => new YamletVariable { Key = p.Key, Value = p.Value, Enabled = true }).ToList();

    [Fact]
    public void Resolve_ReplacesKnownPlaceholder()
    {
        var context = VariableContext.Create(null, null, Vars(("baseUrl", "https://api.example.com")), null);

        var result = _resolver.Resolve("{{baseUrl}}/users", context);

        Assert.Equal("https://api.example.com/users", result);
    }

    [Fact]
    public void Resolve_LeavesUnknownPlaceholderUntouched()
    {
        var result = _resolver.Resolve("{{missing}}/x", VariableContext.Empty);

        Assert.Equal("{{missing}}/x", result);
    }

    [Fact]
    public void Resolve_TrimsWhitespaceInsidePlaceholder()
    {
        var context = VariableContext.Create(null, null, Vars(("token", "abc")), null);

        Assert.Equal("abc", _resolver.Resolve("{{ token }}", context));
    }

    [Fact]
    public void Precedence_RequestBeatsCollectionBeatsEnvironmentBeatsGlobals()
    {
        var context = VariableContext.Create(
            globals: Vars(("v", "globals")),
            environment: Vars(("v", "environment")),
            collection: Vars(("v", "collection")),
            request: Vars(("v", "request")));

        Assert.Equal("request", _resolver.Resolve("{{v}}", context));
    }

    [Fact]
    public void Precedence_FallsThroughWhenHigherLayersAbsent()
    {
        var context = VariableContext.Create(
            globals: Vars(("v", "globals")),
            environment: Vars(("other", "x")),
            collection: null,
            request: null);

        Assert.Equal("globals", _resolver.Resolve("{{v}}", context));
    }

    [Fact]
    public void DisabledVariablesAreIgnored()
    {
        var vars = new List<YamletVariable>
        {
            new() { Key = "v", Value = "off", Enabled = false },
        };
        var context = VariableContext.Create(null, null, vars, null);

        Assert.Equal("{{v}}", _resolver.Resolve("{{v}}", context));
    }

    [Fact]
    public void Resolve_HandlesMultiplePlaceholders()
    {
        var context = VariableContext.Create(
            null, null, Vars(("host", "localhost"), ("port", "8080")), null);

        Assert.Equal("http://localhost:8080", _resolver.Resolve("http://{{host}}:{{port}}", context));
    }
}
