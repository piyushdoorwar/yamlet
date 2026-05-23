using Yamlet.App.Services;

namespace Yamlet.Tests;

/// <summary>
/// Covers reading the YAML shape produced by other tools' exports: environments using
/// <c>values</c>, params using <c>disabled</c>, bodies using <c>content</c>, and
/// headers written as a map rather than a list.
/// </summary>
public class ImportedFormatTests
{
    private readonly YamlSerializationService _yaml = new();

    [Fact]
    public void Environment_ReadsValuesKey()
    {
        const string yaml = """
            name: api_local
            values:
              - key: base_url
                value: 'http://localhost:5444/'
              - key: token
                value: ''
            """;

        var env = _yaml.Deserialize<EnvironmentDto>(yaml).ToDomain(null);

        Assert.Equal("api_local", env.Name);
        Assert.Equal(2, env.Variables.Count);
        Assert.Equal("base_url", env.Variables[0].Key);
        Assert.Equal("http://localhost:5444/", env.Variables[0].Value);
        Assert.True(env.Variables[0].Enabled);
    }

    [Fact]
    public void QueryParam_DisabledFlagDisablesRow()
    {
        const string yaml = """
            method: GET
            url: "{{base_url}}api/scholarships"
            queryParams:
              - key: PageSize
                value: "10"
                disabled: true
              - key: Search
                value: term
            """;

        var request = _yaml.Deserialize<RequestDto>(yaml).ToDomain(null);

        Assert.Equal(2, request.QueryParams.Count);
        Assert.False(request.QueryParams[0].Enabled); // disabled: true
        Assert.True(request.QueryParams[1].Enabled);   // flag absent → enabled
    }

    [Fact]
    public void Body_ReadsContentKeyAndJsonType()
    {
        const string yaml = """
            method: POST
            url: "{{base_url}}api/rules"
            body:
              type: json
              content: |-
                {"a": 1}
            """;

        var request = _yaml.Deserialize<RequestDto>(yaml).ToDomain(null);

        Assert.Equal(Yamlet.App.Models.YamletBodyType.Json, request.Body.Type);
        Assert.Contains("\"a\": 1", request.Body.Raw);
    }

    [Fact]
    public void Headers_ReadFromMap()
    {
        const string yaml = """
            method: POST
            url: https://example.com
            headers:
              Content-Type: application/json
              Accept: application/json
            """;

        var request = _yaml.Deserialize<RequestDto>(yaml).ToDomain(null);

        Assert.Equal(2, request.Headers.Count);
        Assert.Contains(request.Headers, h => h.Key == "Content-Type" && h.Value == "application/json");
        Assert.All(request.Headers, h => Assert.True(h.Enabled));
    }

    [Fact]
    public void Headers_ReadFromList()
    {
        const string yaml = """
            method: GET
            url: https://example.com
            headers:
              - key: Accept
                value: application/json
                enabled: true
            """;

        var request = _yaml.Deserialize<RequestDto>(yaml).ToDomain(null);

        Assert.Single(request.Headers);
        Assert.Equal("Accept", request.Headers[0].Key);
    }

    [Fact]
    public void DeriveNameFromFile_StripsRequestQualifier()
    {
        Assert.Equal("Get All", RequestFileService.DeriveNameFromFile("/x/Get All.request.yaml"));
        Assert.Equal("Health", RequestFileService.DeriveNameFromFile("/x/Health.yaml"));
    }

    [Fact]
    public void Scripts_ClassifiedByPhase()
    {
        const string yaml = """
            method: GET
            url: https://example.com
            scripts:
              - type: preRequest
                code: console.log('before');
              - type: afterResponse
                code: pm.test('ok', () => {});
            """;

        var request = _yaml.Deserialize<RequestDto>(yaml).ToDomain(null);

        Assert.Contains("before", request.PreRequestScript);
        Assert.Contains("pm.test", request.PostResponseScript);
    }

    [Fact]
    public void Scripts_RoundTripThroughDto()
    {
        var request = new Yamlet.App.Models.YamletRequest
        {
            Name = "X", Method = "POST", Url = "https://example.com",
            PreRequestScript = "let a = 1;",
            PostResponseScript = "pm.environment.set('id', 5);",
        };

        var yaml = _yaml.Serialize(RequestDto.FromDomain(request));
        var restored = _yaml.Deserialize<RequestDto>(yaml).ToDomain(null);

        Assert.Equal("let a = 1;", restored.PreRequestScript);
        Assert.Equal("pm.environment.set('id', 5);", restored.PostResponseScript);
    }
}
