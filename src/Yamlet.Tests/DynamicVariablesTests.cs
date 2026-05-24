using System.Text.RegularExpressions;
using Yamlet.App.Models;
using Yamlet.App.Services;

namespace Yamlet.Tests;

public class DynamicVariablesTests
{
    private readonly VariableResolver _resolver = new();

    [Fact]
    public void Catalog_ContainsCommonVariables()
    {
        var names = DynamicVariables.All.Select(v => v.Name).ToHashSet();

        Assert.Contains("$guid", names);
        Assert.Contains("$timestamp", names);
        Assert.Contains("$randomFirstName", names);
        Assert.Contains("$randomInt", names);
        // The catalog should be the full Postman set, not a handful.
        Assert.True(DynamicVariables.All.Count > 80, $"expected the full catalog, got {DynamicVariables.All.Count}");
    }

    [Theory]
    [InlineData("$guid")]
    [InlineData("$randomUUID")]
    [InlineData("$timestamp")]
    [InlineData("$randomFirstName")]
    [InlineData("$randomEmail")]
    public void IsDynamic_RecognizesKnownNames(string name) => Assert.True(DynamicVariables.IsDynamic(name));

    [Fact]
    public void IsDynamic_RejectsUnknownAndUserNames()
    {
        Assert.False(DynamicVariables.IsDynamic("$notARealOne"));
        Assert.False(DynamicVariables.IsDynamic("baseUrl"));
        Assert.False(DynamicVariables.IsDynamic(""));
    }

    [Fact]
    public void Generate_GuidIsParseableUuid()
    {
        Assert.True(DynamicVariables.TryGenerate("$guid", out var value));
        Assert.True(Guid.TryParse(value, out _));
    }

    [Fact]
    public void Generate_RandomIntIsWithinRange()
    {
        Assert.True(DynamicVariables.TryGenerate("$randomInt", out var value));
        var n = int.Parse(value);
        Assert.InRange(n, 0, 1000);
    }

    [Fact]
    public void Resolve_ReplacesDynamicVariable()
    {
        var result = _resolver.Resolve("id={{$guid}}", VariableContext.Empty);

        var match = Regex.Match(result, @"^id=([0-9a-fA-F-]{36})$");
        Assert.True(match.Success, $"unexpected: {result}");
    }

    [Fact]
    public void Resolve_LeavesUnknownDollarPlaceholderUntouched()
    {
        var result = _resolver.Resolve("{{$notARealOne}}", VariableContext.Empty);

        Assert.Equal("{{$notARealOne}}", result);
    }

    [Fact]
    public void Resolve_UserVariableWinsOverDynamicName()
    {
        // A user-defined variable literally named "$guid" should take precedence.
        var context = VariableContext.FromDictionary(new Dictionary<string, string> { ["$guid"] = "fixed" });

        Assert.Equal("fixed", _resolver.Resolve("{{$guid}}", context));
    }

    [Fact]
    public void Resolve_EachOccurrenceGeneratesIndependentValue()
    {
        var result = _resolver.Resolve("{{$randomUUID}}|{{$randomUUID}}", VariableContext.Empty);
        var parts = result.Split('|');

        Assert.NotEqual(parts[0], parts[1]);
    }

    [Fact]
    public void Script_ReplaceInResolvesDynamicVariable()
    {
        var runner = new RequestScriptRunner();
        var request = new YamletRequest
        {
            Method = "GET",
            Url = "https://example.com",
            PreRequestScript = "pm.variables.set('generated', pm.variables.replaceIn('{{$randomUUID}}'));",
        };
        var variables = RequestScriptVariables.FromContext(VariableContext.Empty);

        runner.RunPreRequest(request, variables);

        var generated = variables.GetLocal("generated");
        Assert.NotNull(generated);
        Assert.True(Guid.TryParse(generated, out _), $"unexpected: {generated}");
    }
}
