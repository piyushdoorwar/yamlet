using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;
using YamlDotNet.RepresentationModel;

namespace Yamlet.App.Services;

/// <summary>
/// Thin wrapper over YamlDotNet that serializes/deserializes the on-disk DTOs using
/// a consistent camelCase convention. Domain models are never passed here directly;
/// callers map to/from DTOs first so the file format stays decoupled from the UI.
/// </summary>
public sealed class YamlSerializationService
{
    private readonly ISerializer _serializer;
    private readonly IDeserializer _deserializer;

    public YamlSerializationService()
    {
        _serializer = new SerializerBuilder()
            .WithNamingConvention(CamelCaseNamingConvention.Instance)
            .ConfigureDefaultValuesHandling(DefaultValuesHandling.OmitNull)
            .Build();

        _deserializer = new DeserializerBuilder()
            .WithNamingConvention(CamelCaseNamingConvention.Instance)
            .IgnoreUnmatchedProperties()
            .Build();
    }

    public string Serialize<T>(T value) => _serializer.Serialize(value);

    public string SerializePreservingUnknownTopLevel<T>(T value, string? originalYaml)
    {
        var serialized = Serialize(value);
        if (string.IsNullOrWhiteSpace(originalYaml))
        {
            return serialized;
        }

        try
        {
            var original = LoadMapping(originalYaml);
            var updated = LoadMapping(serialized);
            if (original is null || updated is null)
            {
                return serialized;
            }

            foreach (var child in original.Children)
            {
                var key = child.Key is YamlScalarNode scalar ? scalar.Value : null;
                if (string.IsNullOrWhiteSpace(key) || HasKey(updated, key))
                {
                    continue;
                }

                updated.Add(child.Key, child.Value);
            }

            var stream = new YamlStream(new YamlDocument(updated));
            using var writer = new StringWriter();
            stream.Save(writer, assignAnchors: false);
            return writer.ToString();
        }
        catch
        {
            return serialized;
        }
    }

    public T Deserialize<T>(string yaml) where T : new()
    {
        if (string.IsNullOrWhiteSpace(yaml))
        {
            return new T();
        }

        return _deserializer.Deserialize<T>(yaml) ?? new T();
    }

    private static YamlMappingNode? LoadMapping(string yaml)
    {
        var stream = new YamlStream();
        using var reader = new StringReader(yaml);
        stream.Load(reader);
        return stream.Documents.Count > 0 ? stream.Documents[0].RootNode as YamlMappingNode : null;
    }

    private static bool HasKey(YamlMappingNode mapping, string key) =>
        mapping.Children.Keys
            .OfType<YamlScalarNode>()
            .Any(k => string.Equals(k.Value, key, StringComparison.Ordinal));
}
