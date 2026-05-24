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
    public void Body_FormDataWithListContent_LoadsWithoutFailing()
    {
        // form-data bodies write `content` as a list of field entries (file/text), not
        // a scalar. The request should load those fields into Yamlet's form model.
        const string yaml = """
            $kind: http-request
            method: POST
            url: "{{base_url}}api/documents"
            body:
              type: formdata
              content:
                - type: file
                  key: file
                  src:
                    - upload.txt
                - type: text
                  key: domain
                  value: ccs
            """;

        var request = _yaml.Deserialize<RequestDto>(yaml).ToDomain(null);

        Assert.Equal("POST", request.Method);
        Assert.Equal("{{base_url}}api/documents", request.Url);
        Assert.Equal(Yamlet.App.Models.YamletBodyType.FormData, request.Body.Type);
        Assert.Equal(string.Empty, request.Body.Raw);
        Assert.Equal(2, request.Body.Fields.Count);
        Assert.Contains(request.Body.Fields, f => f.Key == "file" && f.Value == "upload.txt" && f.IsFile);
        Assert.Contains(request.Body.Fields, f => f.Key == "domain" && f.Value == "ccs" && !f.IsFile);
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
    public void CollectionDefinition_ReadsOAuth2VariablesAndScripts()
    {
        // Shape of an exported collection's .resources/definition.yaml: variables as a
        // map, auth as a list with an oauth2 credentials block, collection-scope scripts.
        const string yaml = """
            $kind: collection
            variables:
              aws_m2m_clientId: "abc"
              accessToken: ""
            scripts:
              - type: http:beforeRequest
                code: console.log('pre');
                language: text/javascript
              - type: http:afterResponse
                code: pm.test('ok', () => {});
                language: text/javascript
            auth:
              - id: x
                type: oauth2
                name: oauth2 auth
                credentials:
                  accessTokenUrl: https://issuer/oauth2/token
                  clientId: "{{aws_m2m_clientId}}"
                  clientSecret: "{{secret}}"
                  scope: ccs-api/read
                  grant_type: client_credentials
                  addTokenTo: header
                  client_authentication: header
            """;

        var definition = _yaml.Deserialize<CollectionDefinitionDto>(yaml);
        var collection = new Yamlet.App.Models.YamletCollection();
        definition.ApplyTo(collection);

        Assert.Equal(Yamlet.App.Models.YamletAuthType.OAuth2, collection.Auth.Type);
        Assert.Equal(Yamlet.App.Models.OAuth2GrantType.ClientCredentials, collection.Auth.OAuth2.GrantType);
        Assert.Equal("https://issuer/oauth2/token", collection.Auth.OAuth2.AccessTokenUrl);
        Assert.Equal("{{aws_m2m_clientId}}", collection.Auth.OAuth2.ClientId);
        Assert.Equal("ccs-api/read", collection.Auth.OAuth2.Scope);
        Assert.Contains(collection.Variables, v => v.Key == "aws_m2m_clientId" && v.Value == "abc");
        Assert.Contains("console.log('pre')", collection.PreRequestScript);
        Assert.Contains("pm.test", collection.PostResponseScript);
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
